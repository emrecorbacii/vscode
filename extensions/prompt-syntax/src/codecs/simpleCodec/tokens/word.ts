/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BaseToken } from '../../baseToken';
import { Range } from '../../../utils/vscode';
import { Line } from '../../linesCodec/tokens';

/**
 * A token that represent a word - a set of continuous
 * characters without stop characters, like a `space`,
 * a `tab`, or a `new line`.
 */
export class Word extends BaseToken {
	constructor(
		/**
		 * The word range.
		 */
		range: Range,

		/**
		 * The string value of the word.
		 */
		public readonly text: string,
	) {
		super(range);
	}

	/**
	 * Create new `Word` token with the given `text` and the range
	 * inside the given `Line` at the specified `column number`.
	 */
	public static newOnLine(
		text: string,
		line: Line,
		atColumnNumber: number,
	): Word {
		const { range } = line;

		return new Word(
			new Range(
				range.startLineNumber,
				atColumnNumber,
				range.startLineNumber,
				atColumnNumber + text.length,
			),
			text,
		);
	}

	/**
	 * Check if this token is equal to another one.
	 */
	public override equals<T extends BaseToken>(other: T): boolean {
		if (!super.equals(other)) {
			return false;
		}

		if (!(other instanceof Word)) {
			return false;
		}

		return this.text === other.text;
	}

	/**
	 * Returns a string representation of the token.
	 */
	public override toString(): string {
		return `word("${this.text}")${this.range}`;
	}
}
