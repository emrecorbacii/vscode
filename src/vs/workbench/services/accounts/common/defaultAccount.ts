/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IAuthenticationService } from '../../authentication/common/authentication.js';
import { asJson, IRequestService } from '../../../../platform/request/common/request.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IExtensionService } from '../../extensions/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { Barrier } from '../../../../base/common/async.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { getErrorMessage } from '../../../../base/common/errors.js';

const enum DefaultAccountStatus {
	Uninitialized = 'uninitialized',
	Unavailable = 'unavailable',
	Available = 'available',
}

const CONTEXT_DEFAULT_ACCOUNT_STATE = new RawContextKey<string>('defaultAccountStatus', DefaultAccountStatus.Uninitialized);

export interface IDefaultAccount {
	readonly sessionId: string;
	readonly enterprise: boolean;
	readonly access_type_sku?: string;
	readonly assigned_date?: string;
	readonly can_signup_for_limited?: boolean;
	readonly chat_enabled?: boolean;
	readonly editor_preview_features_enabled?: boolean;
	readonly analytics_tracking_id?: string;
	readonly limited_user_quotas?: {
		readonly chat: number;
		readonly completions: number;
	};
	readonly monthly_quotas?: {
		readonly chat: number;
		readonly completions: number;
	};
	readonly limited_user_reset_date?: string;
}

interface IEntitlementsResponse {
	readonly access_type_sku: string;
	readonly assigned_date: string;
	readonly can_signup_for_limited: boolean;
	readonly chat_enabled: boolean;
	readonly analytics_tracking_id: string;
	readonly limited_user_quotas?: {
		readonly chat: number;
		readonly completions: number;
	};
	readonly monthly_quotas?: {
		readonly chat: number;
		readonly completions: number;
	};
	readonly limited_user_reset_date: string;
}

interface IChatResponse {
	token: string;
}

interface IChatEntitlementsResponse {
	readonly editor_preview_features_enabled?: boolean;
}

export const IDefaultAccountService = createDecorator<IDefaultAccountService>('defaultAccountService');

export interface IDefaultAccountService {

	readonly _serviceBrand: undefined;

	readonly onDidChangeDefaultAccount: Event<IDefaultAccount | null>;

	getDefaultAccount(): Promise<IDefaultAccount | null>;
	setDefaultAccount(account: IDefaultAccount | null): void;
}

export class DefaultAccountService extends Disposable implements IDefaultAccountService {
	declare _serviceBrand: undefined;

	private _defaultAccount: IDefaultAccount | null | undefined = undefined;
	get defaultAccount(): IDefaultAccount | null { return this._defaultAccount ?? null; }

	private readonly initBarrier = new Barrier();

	private readonly _onDidChangeDefaultAccount = this._register(new Emitter<IDefaultAccount | null>());
	readonly onDidChangeDefaultAccount = this._onDidChangeDefaultAccount.event;

	async getDefaultAccount(): Promise<IDefaultAccount | null> {
		await this.initBarrier.wait();
		return this.defaultAccount;
	}

	setDefaultAccount(account: IDefaultAccount | null): void {
		const oldAccount = this._defaultAccount;
		this._defaultAccount = account;

		if (oldAccount !== this._defaultAccount) {
			this._onDidChangeDefaultAccount.fire(this._defaultAccount);
		}

		this.initBarrier.open();
	}

}

export class NullDefaultAccountService extends Disposable implements IDefaultAccountService {

	declare _serviceBrand: undefined;

	readonly onDidChangeDefaultAccount = Event.None;

	async getDefaultAccount(): Promise<IDefaultAccount | null> {
		return null;
	}

	setDefaultAccount(account: IDefaultAccount | null): void {
		// noop
	}

}

export class DefaultAccountManagementContribution extends Disposable implements IWorkbenchContribution {

	static ID = 'workbench.contributions.defaultAccountManagement';

	private defaultAccount: IDefaultAccount | null = null;
	private readonly accountStatusContext: IContextKey<string>;

	constructor(
		@IDefaultAccountService private readonly defaultAccountService: IDefaultAccountService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IProductService private readonly productService: IProductService,
		@IRequestService private readonly requestService: IRequestService,
		@ILogService private readonly logService: ILogService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this.accountStatusContext = CONTEXT_DEFAULT_ACCOUNT_STATE.bindTo(contextKeyService);
		this.initialize();
	}

	private async initialize(): Promise<void> {
		if (!this.productService.defaultAccount) {
			return;
		}

		const { authenticationProvider, entitlementUrl, chatUrl } = this.productService.defaultAccount;
		await this.extensionService.whenInstalledExtensionsRegistered();

		const declaredProvider = this.authenticationService.declaredProviders.find(provider => provider.id === authenticationProvider.id);
		if (!declaredProvider) {
			this.logService.info(`Default account authentication provider ${authenticationProvider} is not declared.`);
			return;
		}

		this.registerSignInAction(authenticationProvider.id, declaredProvider.label, authenticationProvider.enterpriseProviderId, authenticationProvider.enterpriseProviderConfig, authenticationProvider.scopes);
		this.setDefaultAccount(await this.getDefaultAccountFromAuthenticatedSessions(authenticationProvider.id, authenticationProvider.enterpriseProviderId, authenticationProvider.enterpriseProviderConfig, authenticationProvider.scopes, entitlementUrl, chatUrl));

		this.authenticationService.onDidChangeSessions(async e => {
			if (e.providerId !== authenticationProvider.id && e.providerId !== authenticationProvider.enterpriseProviderId) {
				return;
			}

			if (this.defaultAccount && e.event.removed?.some(session => session.id === this.defaultAccount?.sessionId)) {
				this.setDefaultAccount(null);
				return;
			}

			this.setDefaultAccount(await this.getDefaultAccountFromAuthenticatedSessions(authenticationProvider.id, authenticationProvider.enterpriseProviderId, authenticationProvider.enterpriseProviderConfig, authenticationProvider.scopes, entitlementUrl, chatUrl));
		});

	}

	private setDefaultAccount(account: IDefaultAccount | null): void {
		this.defaultAccount = account;
		this.defaultAccountService.setDefaultAccount(this.defaultAccount);
		if (this.defaultAccount) {
			this.accountStatusContext.set(DefaultAccountStatus.Available);
		} else {
			this.accountStatusContext.set(DefaultAccountStatus.Unavailable);
		}
	}

	private extractFromToken(token: string, key: string): string | undefined {
		const result = new Map<string, string>();
		const firstPart = token?.split(':')[0];
		const fields = firstPart?.split(';');
		for (const field of fields) {
			const [key, value] = field.split('=');
			result.set(key, value);
		}
		return result.get(key);
	}

	private async getDefaultAccountFromAuthenticatedSessions(authProviderId: string, enterpriseAuthProviderId: string, enterpriseAuthProviderConfig: string, scopes: string[], entitlementUrl: string, chatUrl: string): Promise<IDefaultAccount | null> {
		const id = this.configurationService.getValue(enterpriseAuthProviderConfig) ? enterpriseAuthProviderId : authProviderId;
		const sessions = await this.authenticationService.getSessions(id, undefined, undefined, true);
		const session = sessions.find(s => this.scopesMatch(s.scopes, scopes));

		if (!session) {
			return null;
		}

		const entitlements = await this.getEntitlements(session.accessToken, entitlementUrl);
		const chatEntitlements = await this.getChatEntitlements(session.accessToken, chatUrl);

		return {
			sessionId: session.id,
			enterprise: id === enterpriseAuthProviderId || session.account.label.includes('_'),
			...entitlements,
			...chatEntitlements,
		};
	}

	private scopesMatch(scopes: ReadonlyArray<string>, expectedScopes: string[]): boolean {
		return scopes.length === expectedScopes.length && expectedScopes.every(scope => scopes.includes(scope));
	}

	private async getChatEntitlements(accessToken: string, chatUrl: string): Promise<IChatEntitlementsResponse> {
		let editor_preview_features_enabled = true;
		const chatContext = await this.requestService.request({
			type: 'GET',
			url: chatUrl,
			disableCache: true,
			headers: {
				'Authorization': `Bearer ${accessToken}`
			}
		}, CancellationToken.None);

		const chatData = await asJson<IChatResponse>(chatContext);
		if (chatData) {
			this.logService.info(`Default account chat data: ${JSON.stringify(chatData)}`);
			// Editor preview features are disabled if the flag is present and set to 0
			editor_preview_features_enabled = this.extractFromToken(chatData.token, 'editor_preview_features') !== '0';
		}

		return {
			editor_preview_features_enabled,
		};
	}

	private async getEntitlements(accessToken: string, entitlementUrl: string): Promise<Partial<IEntitlementsResponse>> {
		try {
			const context = await this.requestService.request({
				type: 'GET',
				url: entitlementUrl,
				disableCache: true,
				headers: {
					'Authorization': `Bearer ${accessToken}`
				}
			}, CancellationToken.None);

			const data = await asJson<IEntitlementsResponse>(context);
			if (data) {
				return data;
			}
			this.logService.error('Failed to fetch entitlements', 'No data returned');
		} catch (error) {
			this.logService.error('Failed to fetch entitlements', getErrorMessage(error));
		}
		return {};
	}

	private registerSignInAction(authProviderId: string, authProviderLabel: string, enterpriseAuthProviderId: string, enterpriseAuthProviderConfig: string, scopes: string[]): void {
		const that = this;
		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: 'workbench.accounts.actions.signin',
					title: localize('sign in', "Sign in to {0}", authProviderLabel),
					menu: {
						id: MenuId.AccountsContext,
						when: CONTEXT_DEFAULT_ACCOUNT_STATE.isEqualTo(DefaultAccountStatus.Unavailable),
						group: '0_signin',
					}
				});
			}
			run(): Promise<any> {
				const id = that.configurationService.getValue(enterpriseAuthProviderConfig) ? enterpriseAuthProviderId : authProviderId;
				return that.authenticationService.createSession(id, scopes);
			}
		}));
	}

}
