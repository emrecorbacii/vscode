/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { equals as arrayEquals } from '../../../../../base/common/arrays.js';
import { Throttler } from '../../../../../base/common/async.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { ISettableObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { Location } from '../../../../../editor/common/languages.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { getMcpServerMapping } from '../mcpConfigFileUtils.js';
import { IMcpConfigPath, IMcpConfigPathsService } from '../mcpConfigPathsService.js';
import { IMcpConfiguration, mcpConfigurationSection } from '../mcpConfiguration.js';
import { IMcpRegistry } from '../mcpRegistryTypes.js';
import { McpServerDefinition, McpServerTransportType } from '../mcpTypes.js';
import { IMcpDiscovery } from './mcpDiscovery.js';

interface ConfigSource {
	path: IMcpConfigPath;
	serverDefinitions: ISettableObservable<readonly McpServerDefinition[]>;
	disposable: MutableDisposable<IDisposable>;
	getServerToLocationMapping(uri: URI): Promise<Map<string, Location>>;
}

/**
 * Discovers MCP servers based on various config sources.
 */
export class ConfigMcpDiscovery extends Disposable implements IMcpDiscovery {
	private readonly configSources: ConfigSource[] = [];

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IMcpRegistry private readonly _mcpRegistry: IMcpRegistry,
		@ITextModelService private readonly _textModelService: ITextModelService,
		@IMcpConfigPathsService private readonly _mcpConfigPathsService: IMcpConfigPathsService,
	) {
		super();
	}

	public start() {
		const throttler = this._register(new Throttler());

		const addPath = (path: IMcpConfigPath) => {
			this.configSources.push({
				path,
				serverDefinitions: observableValue(this, []),
				disposable: this._register(new MutableDisposable()),
				getServerToLocationMapping: (uri) => this._getServerIdMapping(uri, path.section ? [path.section, 'servers'] : ['servers']),
			});
		};

		this._mcpConfigPathsService.paths.forEach(addPath);
		this._register(this._mcpConfigPathsService.onDidAddPath(path => {
			addPath(path);
			this.sync();
		}));

		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(mcpConfigurationSection)) {
				throttler.queue(() => this.sync());
			}
		}));
	}

	private async _getServerIdMapping(resource: URI, pathToServers: string[]): Promise<Map<string, Location>> {
		const store = new DisposableStore();
		try {
			const ref = await this._textModelService.createModelReference(resource);
			store.add(ref);
			const serverIdMapping = getMcpServerMapping({ model: ref.object.textEditorModel, pathToServers });
			return serverIdMapping;
		} catch {
			return new Map();
		} finally {
			store.dispose();
		}
	}

	private async sync() {
		const configurationKey = this._configurationService.inspect<IMcpConfiguration>(mcpConfigurationSection);
		const configMappings = await Promise.all(this.configSources.map(src => {
			const uri = src.path.uri;
			return uri && src.getServerToLocationMapping(uri);
		}));

		for (const [index, src] of this.configSources.entries()) {
			const collectionId = `mcp.config.${src.path.key}`;
			let value = configurationKey[src.path.key];

			// If we see there are MCP servers, migrate them automatically
			if (value?.mcpServers) {
				value = { ...value, servers: { ...value.servers, ...value.mcpServers }, mcpServers: undefined };
				this._configurationService.updateValue(mcpConfigurationSection, value, {}, src.path.target, { donotNotifyError: true });
			}

			const configMapping = configMappings[index];
			const nextDefinitions = Object.entries(value?.servers || {}).map(([name, value]): McpServerDefinition => ({
				id: `${collectionId}.${name}`,
				label: name,
				launch: 'type' in value && value.type === 'sse' ? {
					type: McpServerTransportType.SSE,
					uri: URI.parse(value.url),
					headers: Object.entries(value.headers || {}),
				} : {
					type: McpServerTransportType.Stdio,
					args: value.args || [],
					command: value.command,
					env: value.env || {},
					cwd: undefined,
				},
				variableReplacement: {
					section: mcpConfigurationSection,
					target: src.path.target,
				},
				presentation: {
					order: src.path.order,
					origin: configMapping?.get(name),
				}
			}));

			if (arrayEquals(nextDefinitions, src.serverDefinitions.get(), McpServerDefinition.equals)) {
				continue;
			}

			if (!nextDefinitions.length) {
				src.disposable.clear();
				src.serverDefinitions.set(nextDefinitions, undefined);
			} else {
				src.serverDefinitions.set(nextDefinitions, undefined);
				src.disposable.value ??= this._mcpRegistry.registerCollection({
					id: collectionId,
					label: src.path.label,
					presentation: { order: src.path.order, origin: src.path.uri },
					remoteAuthority: src.path.remoteAuthority || null,
					serverDefinitions: src.serverDefinitions,
					isTrustedByDefault: true,
					scope: src.path.scope,
				});
			}
		}
	}
}
