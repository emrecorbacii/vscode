/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import './media/chatConfirmationWidget.css';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { IMarkdownString, MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { MarkdownRenderer } from '../../../../../editor/browser/widget/markdownRenderer/browser/markdownRenderer.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';

export interface IChatConfirmationButton {
	label: string;
	isSecondary?: boolean;
	tooltip?: string;
	data: any;
}

abstract class BaseChatConfirmationWidget extends Disposable {
	private _onDidClick = this._register(new Emitter<IChatConfirmationButton>());
	get onDidClick(): Event<IChatConfirmationButton> { return this._onDidClick.event; }

	protected _onDidChangeHeight = this._register(new Emitter<void>());
	get onDidChangeHeight(): Event<void> { return this._onDidChangeHeight.event; }

	private _domNode: HTMLElement;
	get domNode(): HTMLElement {
		return this._domNode;
	}

	setShowButtons(showButton: boolean): void {
		this.domNode.classList.toggle('hideButtons', !showButton);
	}

	private readonly messageElement: HTMLElement;
	protected readonly markdownRenderer: MarkdownRenderer;

	constructor(
		title: string,
		rawInput: object | undefined,
		buttons: IChatConfirmationButton[],
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
	) {
		super();

		const elements = dom.h('.chat-confirmation-widget@root', [
			dom.h('.chat-confirmation-widget-title-container@titleContainer', [
				dom.h('.chat-confirmation-widget-expando@expando'),
				dom.h('.chat-confirmation-widget-title@title'),
				dom.h('.chat-confirmation-widget-input-value@inputValue'),
			]),
			dom.h('.chat-confirmation-widget-message@message'),
			dom.h('.chat-confirmation-buttons-container@buttonsContainer'),
		]);
		this._domNode = elements.root;
		this.markdownRenderer = this.instantiationService.createInstance(MarkdownRenderer, {});

		const renderedTitle = this._register(this.markdownRenderer.render(new MarkdownString(title, { supportThemeIcons: true }), {
			asyncRenderCallback: () => this._onDidChangeHeight.fire(),
		}));
		elements.title.append(renderedTitle.element);

		elements.titleContainer.classList.toggle('input', !!rawInput);

		if (rawInput) {

			dom.reset(elements.expando, renderIcon(Codicon.chevronRight));

			const inputMDStr = new MarkdownString().appendCodeblock('json', JSON.stringify(rawInput, undefined, 2));
			const renderedInput = this._register(this.markdownRenderer.render(inputMDStr, { asyncRenderCallback: () => this._onDidChangeHeight.fire() }));
			elements.inputValue.append(renderedInput.element);

			let expanded = false;

			this._register(dom.addStandardDisposableListener(elements.titleContainer, 'click', () => {
				expanded = !expanded;
				elements.titleContainer.classList.toggle('expanded', expanded);
				this._onDidChangeHeight.fire();
				dom.reset(elements.expando, expanded ? renderIcon(Codicon.chevronDown) : renderIcon(Codicon.chevronRight));
			}));
		}

		this.messageElement = elements.message;
		buttons.forEach(buttonData => {
			const button = this._register(new Button(elements.buttonsContainer, { ...defaultButtonStyles, secondary: buttonData.isSecondary, title: buttonData.tooltip }));
			button.label = buttonData.label;
			this._register(button.onDidClick(() => this._onDidClick.fire(buttonData)));
		});
	}

	protected renderMessage(element: HTMLElement): void {
		this.messageElement.append(element);
	}
}

export class ChatConfirmationWidget extends BaseChatConfirmationWidget {
	constructor(
		title: string,
		private readonly message: string | IMarkdownString,
		rawInput: object | undefined,
		buttons: IChatConfirmationButton[],
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(title, rawInput, buttons, instantiationService);

		const renderedMessage = this._register(this.markdownRenderer.render(
			typeof this.message === 'string' ? new MarkdownString(this.message) : this.message,
			{ asyncRenderCallback: () => this._onDidChangeHeight.fire() }
		));
		this.renderMessage(renderedMessage.element);
	}
}

export class ChatCustomConfirmationWidget extends BaseChatConfirmationWidget {
	constructor(
		title: string,
		messageElement: HTMLElement,
		rawInput: object | undefined,
		buttons: IChatConfirmationButton[],
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(title, rawInput, buttons, instantiationService);
		this.renderMessage(messageElement);
	}
}
