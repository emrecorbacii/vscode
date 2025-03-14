/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, IObservable, observableValue, transaction } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { StorageScope } from '../../../../platform/storage/common/storage.js';
import { ILanguageModelToolsService, IToolResult } from '../../chat/common/languageModelToolsService.js';
import { IMcpRegistry } from './mcpRegistryTypes.js';
import { McpServer, McpServerMetadataCache } from './mcpServer.js';
import { IMcpServer, IMcpService, McpCollectionDefinition, McpServerDefinition, McpServerToolsState } from './mcpTypes.js';


export class McpService extends Disposable implements IMcpService {

	declare _serviceBrand: undefined;

	private readonly _servers = observableValue<readonly IMcpServer[]>(this, []);
	public readonly servers: IObservable<readonly IMcpServer[]> = this._servers;

	public get lazyCollectionState() { return this._mcpRegistry.lazyCollectionState; }

	protected readonly userCache: McpServerMetadataCache;
	protected readonly workspaceCache: McpServerMetadataCache;

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IMcpRegistry private readonly _mcpRegistry: IMcpRegistry,
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IProductService productService: IProductService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		this.userCache = this._register(_instantiationService.createInstance(McpServerMetadataCache, StorageScope.PROFILE));
		this.workspaceCache = this._register(_instantiationService.createInstance(McpServerMetadataCache, StorageScope.WORKSPACE));

		const updateThrottle = this._store.add(new RunOnceScheduler(() => this._updateCollectedServers(), 500));

		// Throttle changes so that if a collection is changed, or a server is
		// unregistered/registered, we don't stop servers unnecessarily.
		this._register(autorun(reader => {
			for (const collection of this._mcpRegistry.collections.read(reader)) {
				collection.serverDefinitions.read(reader);
			}
			updateThrottle.schedule(500);
		}));


		const tools = this._register(new MutableDisposable());
		this._register(autorun(r => {

			const servers = this._servers.read(r);

			// TODO@jrieken wasteful, needs some diff'ing/change-info
			const newStore = new DisposableStore();

			tools.clear();

			for (const server of servers) {

				for (const tool of server.tools.read(r)) {

					newStore.add(toolsService.registerToolData({
						id: tool.id,
						displayName: tool.definition.name,
						toolReferenceName: tool.definition.name,
						modelDescription: tool.definition.description ?? '',
						userDescription: tool.definition.description ?? '',
						inputSchema: tool.definition.inputSchema,
						canBeReferencedInPrompt: true,
						tags: ['mcp', 'vscode_editing'] // TODO@jrieken remove this tag
					}));
					newStore.add(toolsService.registerToolImplementation(tool.id, {

						async prepareToolInvocation(parameters, token) {

							const mcpToolWarning = localize(
								'mcp.tool.warning',
								"MCP servers or malicious conversation content may attempt to misuse '{0}' through the installed tools. Please carefully review any requested actions.",
								productService.nameShort
							);

							return {
								confirmationMessages: {
									title: localize('msg.title', "Run `{0}` from $(server) `{1}` (MCP server)", tool.definition.name, server.definition.label),
									message: new MarkdownString(localize('msg.msg', "{0}\n\nInput:\n\n```json\n{1}\n```\n\n$(warning) {2}", tool.definition.description, JSON.stringify(parameters, undefined, 2), mcpToolWarning), { supportThemeIcons: true })
								},
								invocationMessage: new MarkdownString(localize('msg.run', "Running `{0}`", tool.definition.name, server.definition.label)),
								pastTenseMessage: new MarkdownString(localize('msg.ran', "Ran `{0}` ", tool.definition.name, server.definition.label))
							};
						},

						async invoke(invocation, countTokens, token) {

							const result: IToolResult = {
								content: []
							};

							const callResult = await tool.call(invocation.parameters as Record<string, any>, token);
							for (const item of callResult.content) {
								if (item.type === 'text') {
									result.content.push({
										kind: 'text',
										value: item.text
									});
								} else {
									// TODO@jrieken handle different item types
								}
							}

							// result.toolResultMessage = new MarkdownString(localize('reuslt.pattern', "```json\n{0}\n```", JSON.stringify(callResult, undefined, 2)));

							return result;
						},
					}));
				}
			}

			tools.value = newStore;

		}));
	}

	public resetCaches(): void {
		this.userCache.reset();
		this.workspaceCache.reset();
	}

	public async activateCollections(): Promise<void> {
		const collections = await this._mcpRegistry.discoverCollections();
		const collectionIds = new Set(collections.map(c => c.id));

		this._updateCollectedServers();

		// Discover any newly-collected servers with unknown tools
		const todo: Promise<unknown>[] = [];
		for (const server of this._servers.get()) {
			if (collectionIds.has(server.collection.id)) {
				const state = server.toolsState.get();
				if (state === McpServerToolsState.Unknown) {
					todo.push(server.start());
				}
			}
		}

		await Promise.all(todo);
	}

	private _updateCollectedServers() {
		const definitions = this._mcpRegistry.collections.get().flatMap(collectionDefinition =>
			collectionDefinition.serverDefinitions.get().map(serverDefinition => ({
				serverDefinition,
				collectionDefinition,
			}))
		);

		const nextDefinitions = new Set(definitions);
		const currentServers = this._servers.get();
		const nextServers: IMcpServer[] = [];
		const pushMatch = (match: (typeof definitions)[0], server: IMcpServer) => {
			nextDefinitions.delete(match);
			nextServers.push(server);
			const connection = server.connection.get();
			// if the definition was modified, stop the server; it'll be restarted again on-demand
			if (connection && !McpServerDefinition.equals(connection.definition, match.serverDefinition)) {
				server.stop();
				this._logService.debug(`MCP server ${server.definition.id} stopped because the definition changed`);
			}
		};

		// Transfer over any servers that are still valid.
		for (const server of currentServers) {
			const match = definitions.find(d => defsEqual(server, d));
			if (match) {
				pushMatch(match, server);
			} else {
				server.dispose();
			}
		}

		// Create any new servers that are needed.
		for (const def of nextDefinitions) {
			nextServers.push(this._instantiationService.createInstance(McpServer, def.collectionDefinition, def.serverDefinition, false, def.collectionDefinition.scope === StorageScope.WORKSPACE ? this.workspaceCache : this.userCache));
		}

		transaction(tx => {
			this._servers.set(nextServers, tx);
		});
	}

	public override dispose(): void {
		this._servers.get().forEach(server => server.dispose());
		super.dispose();
	}
}

function defsEqual(server: IMcpServer, def: { serverDefinition: McpServerDefinition; collectionDefinition: McpCollectionDefinition }) {
	return server.collection.id === def.collectionDefinition.id && server.definition.id === def.serverDefinition.id;
}
