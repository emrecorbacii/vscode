/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Relay, Event } from '../../../../../base/common/event.js';
import { IMarkdownString, MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { MarkdownRenderer } from '../../../../../editor/browser/widget/markdownRenderer/browser/markdownRenderer.js';
import { localize } from '../../../../../nls.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IChatProgressMessage, IChatToolInvocation, IChatToolInvocationSerialized } from '../../common/chatService.js';
import { IChatRendererContent } from '../../common/chatViewModel.js';
import { IToolResult } from '../../common/languageModelToolsService.js';
import { CancelChatActionId } from '../actions/chatExecuteActions.js';
import { AcceptToolConfirmationActionId } from '../actions/chatToolActions.js';
import { ChatTreeItem } from '../chat.js';
import { ChatConfirmationWidget } from './chatConfirmationWidget.js';
import { IChatContentPart, IChatContentPartRenderContext } from './chatContentParts.js';
import { ChatProgressContentPart } from './chatProgressContentPart.js';
import { ChatTerminalToolView } from './chatTerminalToolInvocationPart.js';

export interface IChatToolInvocationView extends IDisposable {
	domNode: HTMLElement;
	onDidChangeHeight: Event<void>;
	onNeedsRerender: Event<void>;
}
import { ChatCollapsibleListContentPart, CollapsibleListPool, IChatCollapsibleListItem } from './chatReferencesContentPart.js';

export class ChatToolInvocationPart extends Disposable implements IChatContentPart {
	public readonly domNode: HTMLElement;

	private _onDidChangeHeight = this._register(new Emitter<void>());
	public readonly onDidChangeHeight = this._onDidChangeHeight.event;

	constructor(
		toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized,
		context: IChatContentPartRenderContext,
		renderer: MarkdownRenderer,
		listPool: CollapsibleListPool,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();

		this.domNode = dom.$('.chat-tool-invocation-part');
		if (toolInvocation.presentation === 'hidden') {
			return;
		}

		// This part is a bit different, since IChatToolInvocation is not an immutable model object. So this part is able to rerender itself.
		// If this turns out to be a typical pattern, we could come up with a more reusable pattern, like telling the list to rerender an element
		// when the model changes, or trying to make the model immutable and swap out one content part for a new one based on user actions in the view.
		const partStore = this._register(new DisposableStore());
		const render = () => {
			dom.clearNode(this.domNode);
			partStore.clear();

			const subPart = partStore.add(this.createView(toolInvocation, context, renderer, listPool));
			this.domNode.appendChild(subPart.domNode);
			partStore.add(subPart.onDidChangeHeight(() => this._onDidChangeHeight.fire()));
			partStore.add(subPart.onNeedsRerender(() => {
				render();
				this._onDidChangeHeight.fire();
			}));
		};
		render();
	}

	private createView(
		toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized,
		context: IChatContentPartRenderContext,
		renderer: MarkdownRenderer,): IChatToolInvocationView {
		if (toolInvocation.toolInvocation?.toolId === 'copilot_findFiles') {
			return this.instantiationService.createInstance(ChatTerminalToolView, toolInvocation, context, renderer);
		} else {
			return this.instantiationService.createInstance(GenericChatToolInvocationView, toolInvocation, context, renderer);
		}
	}

	hasSameContent(other: IChatRendererContent, followingContent: IChatRendererContent[], element: ChatTreeItem): boolean {
		return other.kind === 'toolInvocation' || other.kind === 'toolInvocationSerialized';
	}

	addDisposable(disposable: IDisposable): void {
		this._register(disposable);
	}
}

class GenericChatToolInvocationView extends Disposable implements IChatToolInvocationView {
	public readonly domNode: HTMLElement;

	private _onNeedsRerender = this._register(new Emitter<void>());
	public readonly onNeedsRerender = this._onNeedsRerender.event;

	private _onDidChangeHeight = this._register(new Relay<void>());
	public readonly onDidChangeHeight = this._onDidChangeHeight.event;

	constructor(
		toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized,
		context: IChatContentPartRenderContext,
		renderer: MarkdownRenderer,
		listPool: CollapsibleListPool,
		@IInstantiationService instantiationService: IInstantiationService,
		@IHoverService hoverService: IHoverService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
	) {
		super();

		if (toolInvocation.kind === 'toolInvocation' && toolInvocation.confirmationMessages) {
			this.domNode = this.createConfirmationWidget(toolInvocation, instantiationService);
		} else if (toolInvocation.resultDetails?.length) {
			this.domNode = this.createResultList(toolInvocation.pastTenseMessage ?? toolInvocation.invocationMessage, toolInvocation.resultDetails, context, instantiationService, listPool);
		} else {
			this.domNode = this.createProgressPart(toolInvocation, context, renderer, instantiationService, hoverService);
		}

		if (toolInvocation.kind === 'toolInvocation' && !toolInvocation.isComplete) {
			toolInvocation.isCompletePromise.then(() => this._onNeedsRerender.fire());
		}
	}

	private createConfirmationWidget(toolInvocation: IChatToolInvocation, instantiationService: IInstantiationService): HTMLElement {
		if (!toolInvocation.confirmationMessages) {
			throw new Error('Confirmation messages are missing');
		}
		const title = toolInvocation.confirmationMessages.title;
		const message = toolInvocation.confirmationMessages.message;
		const continueLabel = localize('continue', "Continue");
		const continueKeybinding = this.keybindingService.lookupKeybinding(AcceptToolConfirmationActionId)?.getLabel();
		const continueTooltip = continueKeybinding ? `${continueLabel} (${continueKeybinding})` : continueLabel;
		const cancelLabel = localize('cancel', "Cancel");
		const cancelKeybinding = this.keybindingService.lookupKeybinding(CancelChatActionId)?.getLabel();
		const cancelTooltip = cancelKeybinding ? `${cancelLabel} (${cancelKeybinding})` : cancelLabel;
		const confirmWidget = this._register(instantiationService.createInstance(
			ChatConfirmationWidget,
			title,
			message,
			[
				{
					label: continueLabel,
					data: true,
					tooltip: continueTooltip
				},
				{
					label: cancelLabel,
					data: false,
					isSecondary: true,
					tooltip: cancelTooltip
				}]
		));
		this._register(confirmWidget.onDidClick(button => {
			toolInvocation.confirmed.complete(button.data);
		}));
		this._onDidChangeHeight.input = confirmWidget.onDidChangeHeight;
		toolInvocation.confirmed.p.then(() => {
			this._onNeedsRerender.fire();
		});
		return confirmWidget.domNode;
	}

	private createProgressPart(
		toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized,
		context: IChatContentPartRenderContext,
		renderer: MarkdownRenderer,
		instantiationService: IInstantiationService,
		hoverService: IHoverService
	): HTMLElement {
		let content: IMarkdownString;
		if (toolInvocation.isComplete && toolInvocation.isConfirmed !== false && toolInvocation.pastTenseMessage) {
			content = typeof toolInvocation.pastTenseMessage === 'string' ?
				new MarkdownString().appendText(toolInvocation.pastTenseMessage) :
				toolInvocation.pastTenseMessage;
		} else {
			content = typeof toolInvocation.invocationMessage === 'string' ?
				new MarkdownString().appendText(toolInvocation.invocationMessage + '…') :
				new MarkdownString(toolInvocation.invocationMessage.value + '…');
		}

		const progressMessage: IChatProgressMessage = {
			kind: 'progressMessage',
			content
		};
		const iconOverride = toolInvocation.isConfirmed === false ?
			Codicon.error :
			toolInvocation.isComplete ?
				Codicon.check : undefined;
		const progressPart = this._register(instantiationService.createInstance(ChatProgressContentPart, progressMessage, renderer, context, undefined, true, iconOverride));
		if (toolInvocation.tooltip) {
			this._register(hoverService.setupDelayedHover(progressPart.domNode, { content: toolInvocation.tooltip, additionalClasses: ['chat-tool-hover'] }));
		}

		return progressPart.domNode;
	}

	private createResultList(
		message: string | IMarkdownString,
		toolDetails: NonNullable<IToolResult['toolResultDetails']>,
		context: IChatContentPartRenderContext,
		instantiationService: IInstantiationService,
		listPool: CollapsibleListPool
	): HTMLElement {
		const collapsibleListPart = this._register(instantiationService.createInstance(
			ChatCollapsibleListContentPart,
			toolDetails.map<IChatCollapsibleListItem>(detail => ({
				kind: 'reference',
				reference: detail,
			})),
			message,
			context,
			listPool,
		));
		this._onDidChangeHeight.input = collapsibleListPart.onDidChangeHeight;
		return collapsibleListPart.domNode;
	}
}
