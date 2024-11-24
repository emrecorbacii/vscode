/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler, timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter } from '../../../../../base/common/event.js';
import { StringSHA1 } from '../../../../../base/common/hash.js';
import { Disposable, IReference, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IObservable, ITransaction, observableValue, transaction } from '../../../../../base/common/observable.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { themeColorFromId } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { EditOperation, ISingleEditOperation } from '../../../../../editor/common/core/editOperation.js';
import { ISingleOffsetEdit, OffsetEdit } from '../../../../../editor/common/core/offsetEdit.js';
import { IDocumentDiff, nullDocumentDiff } from '../../../../../editor/common/diff/documentDiffProvider.js';
import { TextEdit } from '../../../../../editor/common/languages.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IModelDeltaDecoration, ITextModel, OverviewRulerLane } from '../../../../../editor/common/model.js';
import { SingleModelEditStackElement } from '../../../../../editor/common/model/editStack.js';
import { ModelDecorationOptions, createTextBufferFactoryFromSnapshot } from '../../../../../editor/common/model/textModel.js';
import { OffsetEdits } from '../../../../../editor/common/model/textModelOffsetEdit.js';
import { IEditorWorkerService } from '../../../../../editor/common/services/editorWorker.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { IModelContentChangedEvent } from '../../../../../editor/common/textModelEvents.js';
import { localize } from '../../../../../nls.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { editorSelectionBackground } from '../../../../../platform/theme/common/colorRegistry.js';
import { IUndoRedoService } from '../../../../../platform/undoRedo/common/undoRedo.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { SaveReason } from '../../../../common/editor.js';
import { IResolvedTextFileEditorModel, stringToSnapshot } from '../../../../services/textfile/common/textfiles.js';
import { ChatEditKind, IModifiedEntryTelemetryInfo, IModifiedTextFileEntry, ITextSnapshotEntry, ITextSnapshotEntryDTO, STORAGE_CONTENTS_FOLDER, WorkingSetEntryState } from '../../common/chatEditingService.js';
import { IChatService } from '../../common/chatService.js';
import { ChatEditingSnapshotTextModelContentProvider, ChatEditingTextModelContentProvider } from './chatEditingTextModelContentProviders.js';

export class ChatEditingModifiedFileEntry extends Disposable implements IModifiedTextFileEntry {
	public readonly kind = 'text';
	public static readonly scheme = 'modified-file-entry';
	private static lastEntryId = 0;
	public readonly entryId = `${ChatEditingModifiedFileEntry.scheme}::${++ChatEditingModifiedFileEntry.lastEntryId}`;

	private readonly docSnapshot: ITextModel;
	public readonly initialContent: string;
	private readonly doc: ITextModel;
	private readonly docFileEditorModel: IResolvedTextFileEditorModel;
	private _allEditsAreFromUs: boolean = true;

	private readonly _onDidDelete = this._register(new Emitter<void>());
	public get onDidDelete() {
		return this._onDidDelete.event;
	}

	get originalURI(): URI {
		return this.docSnapshot.uri;
	}

	get originalModel(): ITextModel {
		return this.docSnapshot;
	}

	get modifiedURI(): URI {
		return this.modifiedModel.uri;
	}

	get modifiedModel(): ITextModel {
		return this.doc;
	}

	private readonly _stateObs = observableValue<WorkingSetEntryState>(this, WorkingSetEntryState.Modified);
	public get state(): IObservable<WorkingSetEntryState> {
		return this._stateObs;
	}

	private readonly _isCurrentlyBeingModifiedObs = observableValue<boolean>(this, false);
	public get isCurrentlyBeingModified(): IObservable<boolean> {
		return this._isCurrentlyBeingModifiedObs;
	}

	private readonly _rewriteRatioObs = observableValue<number>(this, 0);
	public get rewriteRatio(): IObservable<number> {
		return this._rewriteRatioObs;
	}

	private _isFirstEditAfterStartOrSnapshot: boolean = true;
	private _edit: OffsetEdit = OffsetEdit.empty;
	private _isEditFromUs: boolean = false;
	private _diffOperation: Promise<any> | undefined;
	private _diffOperationIds: number = 0;

	private readonly _diffInfo = observableValue<IDocumentDiff>(this, nullDocumentDiff);
	get diffInfo(): IObservable<IDocumentDiff> {
		return this._diffInfo;
	}

	private readonly _editDecorationClear = this._register(new RunOnceScheduler(() => { this._editDecorations = this.doc.deltaDecorations(this._editDecorations, []); }, 3000));
	private _editDecorations: string[] = [];

	private static readonly _editDecorationOptions = ModelDecorationOptions.register({
		isWholeLine: true,
		description: 'chat-editing',
		className: 'rangeHighlight',
		marginClassName: 'rangeHighlight',
		overviewRuler: {
			position: OverviewRulerLane.Full,
			color: themeColorFromId(editorSelectionBackground)
		},
	});

	get telemetryInfo(): IModifiedEntryTelemetryInfo {
		return this._telemetryInfo;
	}

	readonly createdInRequestId: string | undefined;

	get lastModifyingRequestId() {
		return this._telemetryInfo.requestId;
	}

	constructor(
		resourceRef: IReference<IResolvedTextEditorModel>,
		private readonly _multiDiffEntryDelegate: { collapse: (transaction: ITransaction | undefined) => void },
		private _telemetryInfo: IModifiedEntryTelemetryInfo,
		kind: ChatEditKind,
		initialContent: string | undefined,
		@IModelService modelService: IModelService,
		@ITextModelService textModelService: ITextModelService,
		@ILanguageService languageService: ILanguageService,
		@IChatService private readonly _chatService: IChatService,
		@IEditorWorkerService private readonly _editorWorkerService: IEditorWorkerService,
		@IUndoRedoService private readonly _undoRedoService: IUndoRedoService,
		@IFileService private readonly _fileService: IFileService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		if (kind === ChatEditKind.Created) {
			this.createdInRequestId = this._telemetryInfo.requestId;
		}
		this.docFileEditorModel = this._register(resourceRef).object as IResolvedTextFileEditorModel;
		this.doc = resourceRef.object.textEditorModel;

		this.initialContent = initialContent ?? this.doc.getValue();
		const docSnapshot = this.docSnapshot = this._register(
			modelService.createModel(
				createTextBufferFactoryFromSnapshot(initialContent ? stringToSnapshot(initialContent) : this.doc.createSnapshot()),
				languageService.createById(this.doc.getLanguageId()),
				ChatEditingTextModelContentProvider.getFileURI(this.entryId, this.modifiedURI.path),
				false
			)
		);

		// Create a reference to this model to avoid it being disposed from under our nose
		(async () => {
			const reference = await textModelService.createModelReference(docSnapshot.uri);
			if (this._store.isDisposed) {
				reference.dispose();
				return;
			}
			this._register(reference);
		})();


		this._register(this.doc.onDidChangeContent(e => this._mirrorEdits(e)));
		this._register(this._fileService.watch(this.modifiedURI));
		this._register(this._fileService.onDidFilesChange(e => {
			if (e.affects(this.modifiedURI) && kind === ChatEditKind.Created && e.gotDeleted()) {
				this._onDidDelete.fire();
			}
		}));

		this._register(toDisposable(() => {
			this._clearCurrentEditLineDecoration();
		}));
	}

	private _clearCurrentEditLineDecoration() {
		this._editDecorations = this.doc.deltaDecorations(this._editDecorations, []);
	}

	updateTelemetryInfo(telemetryInfo: IModifiedEntryTelemetryInfo) {
		this._telemetryInfo = telemetryInfo;
	}

	createSnapshot(requestId: string | undefined): ITextSnapshotEntry {
		this._isFirstEditAfterStartOrSnapshot = true;
		return TextSnapshotEntry.create(this, requestId, this._edit, this.instantiationService);
	}

	restoreFromSnapshot(snapshot: ITextSnapshotEntry) {
		this._stateObs.set(snapshot.state, undefined);
		this.docSnapshot.setValue(snapshot.original);
		this._setDocValue(snapshot.current);
		this._edit = snapshot.originalToCurrentEdit;
	}

	resetToInitialValue() {
		this._setDocValue(this.initialContent);
	}

	acceptStreamingEditsStart(tx: ITransaction) {
		this._resetEditsState(tx);
	}

	acceptStreamingEditsEnd(tx: ITransaction) {
		this._resetEditsState(tx);
	}

	private _resetEditsState(tx: ITransaction): void {
		this._isCurrentlyBeingModifiedObs.set(false, tx);
		this._rewriteRatioObs.set(0, tx);
		this._clearCurrentEditLineDecoration();
	}

	private _mirrorEdits(event: IModelContentChangedEvent) {
		const edit = OffsetEdits.fromContentChanges(event.changes);

		if (this._isEditFromUs) {
			const e_sum = this._edit;
			const e_ai = edit;
			this._edit = e_sum.compose(e_ai);

		} else {

			//           e_ai
			//   d0 ---------------> s0
			//   |                   |
			//   |                   |
			//   | e_user_r          | e_user
			//   |                   |
			//   |                   |
			//   v       e_ai_r      v
			///  d1 ---------------> s1
			//
			// d0 - document snapshot
			// s0 - document
			// e_ai - ai edits
			// e_user - user edits
			//

			const e_ai = this._edit;
			const e_user = edit;

			const e_user_r = e_user.tryRebase(e_ai.inverse(this.docSnapshot.getValue()), true);

			if (e_user_r === undefined) {
				// user edits overlaps/conflicts with AI edits
				this._edit = e_ai.compose(e_user);
			} else {
				const edits = OffsetEdits.asEditOperations(e_user_r, this.docSnapshot);
				this.docSnapshot.applyEdits(edits);
				this._edit = e_ai.tryRebase(e_user_r);
			}

			this._allEditsAreFromUs = false;
		}

		if (!this.isCurrentlyBeingModified.get()) {
			const didResetToOriginalContent = this.doc.getValue() === this.initialContent;
			const currentState = this._stateObs.get();
			switch (currentState) {
				case WorkingSetEntryState.Modified:
					if (didResetToOriginalContent) {
						this._stateObs.set(WorkingSetEntryState.Rejected, undefined);
						break;
					}
			}
		}

		this._updateDiffInfoSeq(!this._isEditFromUs);
	}

	acceptAgentEdits(textEdits: TextEdit[], isLastEdits: boolean): void {

		// highlight edits
		this._editDecorations = this.doc.deltaDecorations(this._editDecorations, textEdits.map(edit => {
			return {
				options: ChatEditingModifiedFileEntry._editDecorationOptions,
				range: edit.range
			} satisfies IModelDeltaDecoration;
		}));
		this._editDecorationClear.schedule();

		// push stack element for the first edit
		if (this._isFirstEditAfterStartOrSnapshot) {
			this._isFirstEditAfterStartOrSnapshot = false;
			const request = this._chatService.getSession(this._telemetryInfo.sessionId)?.getRequests().at(-1);
			const label = request?.message.text ? localize('chatEditing1', "Chat Edit: '{0}'", request.message.text) : localize('chatEditing2', "Chat Edit");
			this._undoRedoService.pushElement(new SingleModelEditStackElement(label, 'chat.edit', this.doc, null));
		}

		const ops = textEdits.map(TextEdit.asEditOperation);
		this._applyEdits(ops);

		transaction((tx) => {
			if (!isLastEdits) {
				this._stateObs.set(WorkingSetEntryState.Modified, tx);
				this._isCurrentlyBeingModifiedObs.set(true, tx);
				const maxLineNumber = ops.reduce((max, op) => Math.max(max, op.range.endLineNumber), 0);
				const lineCount = this.doc.getLineCount();
				this._rewriteRatioObs.set(Math.min(1, maxLineNumber / lineCount), tx);
			} else {
				this._resetEditsState(tx);
				this._updateDiffInfoSeq(true);
				this._rewriteRatioObs.set(1, tx);
			}
		});
	}

	private _applyEdits(edits: ISingleEditOperation[]) {
		// make the actual edit
		this._isEditFromUs = true;
		try {
			this.doc.pushEditOperations(null, edits, () => null);
		} finally {
			this._isEditFromUs = false;
		}
	}

	private _updateDiffInfoSeq(fast: boolean) {
		const myDiffOperationId = ++this._diffOperationIds;
		Promise.resolve(this._diffOperation).then(() => {
			if (this._diffOperationIds === myDiffOperationId) {
				this._diffOperation = this._updateDiffInfo(fast);
			}
		});
	}

	private async _updateDiffInfo(fast: boolean): Promise<void> {

		if (this.docSnapshot.isDisposed() || this.doc.isDisposed()) {
			return;
		}

		const docVersionNow = this.doc.getVersionId();
		const snapshotVersionNow = this.docSnapshot.getVersionId();

		const [diff] = await Promise.all([
			this._editorWorkerService.computeDiff(
				this.docSnapshot.uri,
				this.doc.uri,
				{ computeMoves: true, ignoreTrimWhitespace: false, maxComputationTimeMs: 3000 },
				'advanced'
			),
			timeout(fast ? 50 : 800) // DON't diff too fast
		]);

		if (this.docSnapshot.isDisposed() || this.doc.isDisposed()) {
			return;
		}

		// only update the diff if the documents didn't change in the meantime
		if (this.doc.getVersionId() === docVersionNow && this.docSnapshot.getVersionId() === snapshotVersionNow) {
			const diff2 = diff ?? nullDocumentDiff;
			this._diffInfo.set(diff2, undefined);
			this._edit = OffsetEdits.fromLineRangeMapping(this.docSnapshot, this.doc, diff2.changes);
		}
	}

	async accept(transaction: ITransaction | undefined): Promise<void> {
		if (this._stateObs.get() !== WorkingSetEntryState.Modified) {
			// already accepted or rejected
			return;
		}

		this.docSnapshot.setValue(this.doc.createSnapshot());
		this._edit = OffsetEdit.empty;
		this._stateObs.set(WorkingSetEntryState.Accepted, transaction);
		await this.collapse(transaction);
		this._notifyAction('accepted');
	}

	async reject(transaction: ITransaction | undefined): Promise<void> {
		if (this._stateObs.get() !== WorkingSetEntryState.Modified) {
			// already accepted or rejected
			return;
		}

		this._stateObs.set(WorkingSetEntryState.Rejected, transaction);
		this._notifyAction('rejected');
		if (this.createdInRequestId === this._telemetryInfo.requestId) {
			await this._fileService.del(this.modifiedURI);
			this._onDidDelete.fire();
		} else {
			this._setDocValue(this.docSnapshot.getValue());
			if (this._allEditsAreFromUs) {
				// save the file after discarding so that the dirty indicator goes away
				// and so that an intermediate saved state gets reverted
				await this.docFileEditorModel.save({ reason: SaveReason.EXPLICIT });
			}
			await this.collapse(transaction);
		}
	}

	private _setDocValue(value: string): void {
		if (this.doc.getValue() !== value) {

			this.doc.pushStackElement();
			const edit = EditOperation.replace(this.doc.getFullModelRange(), value);

			this._applyEdits([edit]);

			this.doc.pushStackElement();
		}
	}

	async collapse(transaction: ITransaction | undefined): Promise<void> {
		this._multiDiffEntryDelegate.collapse(transaction);
	}

	private _notifyAction(outcome: 'accepted' | 'rejected') {
		this._chatService.notifyUserAction({
			action: { kind: 'chatEditingSessionAction', uri: this.modifiedURI, hasRemainingEdits: false, outcome },
			agentId: this._telemetryInfo.agentId,
			command: this._telemetryInfo.command,
			sessionId: this._telemetryInfo.sessionId,
			requestId: this._telemetryInfo.requestId,
			result: this._telemetryInfo.result
		});
	}
}


export class TextSnapshotEntry implements ITextSnapshotEntry {
	public readonly kind = 'text';
	constructor(
		public readonly languageId: string,
		public readonly original: string,
		public readonly current: string,
		public readonly originalToCurrentEdit: OffsetEdit,
		public readonly resource: URI,
		public readonly snapshotUri: URI,
		public readonly state: WorkingSetEntryState,
		public readonly telemetryInfo: IModifiedEntryTelemetryInfo,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
	) {
	}

	public static create(entry: IModifiedTextFileEntry, requestId: string | undefined,
		edit: OffsetEdit, instantiationService: IInstantiationService): TextSnapshotEntry {

		return instantiationService.createInstance(TextSnapshotEntry,
			entry.modifiedModel.getLanguageId(),
			entry.originalModel.getValue(),
			entry.modifiedModel.getValue(),
			edit,
			entry.modifiedURI,
			ChatEditingSnapshotTextModelContentProvider.getSnapshotFileURI(requestId, entry.modifiedURI.path),
			entry.state.get(),
			entry.telemetryInfo);
	}

	public static async deserialize(entry: ITextSnapshotEntryDTO, chatSessionId: string, instantiationService: IInstantiationService): Promise<TextSnapshotEntry> {
		return instantiationService.invokeFunction(async accessor => {
			const workspaceContextService = accessor.get(IWorkspaceContextService);
			const environmentService = accessor.get(IEnvironmentService);
			const fileService = accessor.get(IFileService);
			const storageLocation = getStorageLocation(chatSessionId, workspaceContextService, environmentService);

			const [original, current] = await Promise.all([
				getFileContent(entry.originalHash, fileService, storageLocation),
				getFileContent(entry.currentHash, fileService, storageLocation)
			]);

			return instantiationService.createInstance(TextSnapshotEntry,
				entry.languageId,
				original,
				current,
				OffsetEdit.fromJson(entry.originalToCurrentEdit),
				URI.parse(entry.resource),
				URI.parse(entry.snapshotUri),
				entry.state,
				{ requestId: entry.telemetryInfo.requestId, agentId: entry.telemetryInfo.agentId, command: entry.telemetryInfo.command, sessionId: chatSessionId, result: undefined }
			);
		});
	}

	async serialize(): Promise<ITextSnapshotEntryDTO> {
		const fileContents = new Map<string, string>();
		const serialized = {
			kind: 'text',
			resource: this.resource.toString(),
			languageId: this.languageId,
			originalHash: this.computeContentHash(this.original),
			currentHash: this.computeContentHash(this.current),
			originalToCurrentEdit: this.originalToCurrentEdit.edits.map(edit => ({ pos: edit.replaceRange.start, len: edit.replaceRange.length, txt: edit.newText } satisfies ISingleOffsetEdit)),
			state: this.state,
			snapshotUri: this.snapshotUri.toString(),
			telemetryInfo: { requestId: this.telemetryInfo.requestId, agentId: this.telemetryInfo.agentId, command: this.telemetryInfo.command }
		} satisfies ITextSnapshotEntryDTO;

		const storageFolder = getStorageLocation(this.telemetryInfo.sessionId, this._workspaceContextService, this._environmentService);
		const contentsFolder = URI.joinPath(storageFolder, STORAGE_CONTENTS_FOLDER);

		await Promise.all(Array.from(fileContents.entries()).map(async ([hash, content]) => {
			const file = joinPath(contentsFolder, hash);
			if (!(await this._fileService.exists(file))) {
				await this._fileService.writeFile(joinPath(contentsFolder, hash), VSBuffer.fromString(content));
			}
		}));

		return serialized;
	}
	private computeContentHash(content: string): string {
		const shaComputer = new StringSHA1();
		shaComputer.update(content);
		return shaComputer.digest().substring(0, 7);
	}
}

export function getStorageLocation(chatSessionId: string, workspaceContextService: IWorkspaceContextService, environmentService: IEnvironmentService): URI {
	const workspaceId = workspaceContextService.getWorkspace().id;
	return joinPath(environmentService.workspaceStorageHome, workspaceId, 'chatEditingSessions', chatSessionId);
}

function getFileContent(hash: string, fileService: IFileService, storageLocation: URI) {
	return fileService.readFile(joinPath(storageLocation, STORAGE_CONTENTS_FOLDER, hash)).then(content => content.value.toString());
}

