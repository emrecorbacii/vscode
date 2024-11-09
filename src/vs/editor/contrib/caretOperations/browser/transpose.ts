/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorAction, registerEditorAction, ServicesAccessor } from '../../../browser/editorExtensions.js';
import { ReplaceCommand } from '../../../common/commands/replaceCommand.js';
import { MoveOperations } from '../../../common/cursor/cursorMoveOperations.js';
import { Range } from '../../../common/core/range.js';
import { ICommand } from '../../../common/editorCommon.js';
import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import * as nls from '../../../../nls.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';

class TransposeLettersAction extends EditorAction {

	constructor() {
		super({
			id: 'editor.action.transposeLetters',
			label: nls.localize('transposeLetters.label', "Transpose Letters"),
			alias: 'Transpose Letters',
			precondition: EditorContextKeys.writable,
			kbOpts: {
				kbExpr: EditorContextKeys.textInputFocus,
				primary: 0,
				mac: {
					primary: KeyMod.WinCtrl | KeyCode.KeyT
				},
				weight: KeybindingWeight.EditorContrib
			}
		});
	}

	public run(accessor: ServicesAccessor, editor: ICodeEditor): void {
		if (!editor.hasModel()) {
			return;
		}

		const model = editor.getModel();
		const commands: ICommand[] = [];
		const selections = editor.getSelections();

		for (const selection of selections) {
			if (!selection.isEmpty()) {
				continue;
			}

			const lineNumber = selection.startLineNumber;
			const column = selection.startColumn;

			const lastColumn = model.getLineMaxColumn(lineNumber);

			if (lineNumber === 1 && (column === 1 || (column === 2 && lastColumn === 2))) {
				// at beginning of file, nothing to do
				continue;
			}

			// console.log('column:', column);
			// console.log('lastColumn:', lastColumn);
			if (column > lastColumn) {
				// beyond the end of line, nothing to do
				continue;
			}
			// The `virtualSpace` argument to `rightPosition()` and `leftPosition()`
			// is not important here because we're not beyond the end of the line.

			// handle special case: when at end of line, transpose left two chars
			// otherwise, transpose left and right chars
			const endPosition = (column === lastColumn) ?
				selection.getPosition() :
				MoveOperations.rightPosition(model, selection.getPosition().lineNumber, selection.getPosition().column, false);

			const middlePosition = MoveOperations.leftPosition(model, endPosition, false);
			const beginPosition = MoveOperations.leftPosition(model, middlePosition, false);

			const leftChar = model.getValueInRange(Range.fromPositions(beginPosition, middlePosition));
			const rightChar = model.getValueInRange(Range.fromPositions(middlePosition, endPosition));

			const replaceRange = Range.fromPositions(beginPosition, endPosition);
			commands.push(new ReplaceCommand(replaceRange, rightChar + leftChar));
		}

		if (commands.length > 0) {
			editor.pushUndoStop();
			editor.executeCommands(this.id, commands);
			editor.pushUndoStop();
		}
	}
}

registerEditorAction(TransposeLettersAction);
