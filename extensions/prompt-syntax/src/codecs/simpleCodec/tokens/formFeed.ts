/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BaseToken } from '../../baseToken';
import { Range } from '../../../utils/vscode';
import { Line } from '../../linesCodec/tokens';

/**
 * Token that represent a `form feed` with a `range`. The `range`
 * value reflects the position of the token in the original data.
 */
export class FormFeed extends BaseToken {
	/**
	 * The underlying symbol of the token.
	 */
	public static readonly symbol: string = '\f';

	/**
	 * Return text representation of the token.
	 */
	public get text(): string {
		return FormFeed.symbol;
	}

	/**
	 * Create new `FormFeed` token with range inside
	 * the given `Line` at the given `column number`.
	 */
	public static newOnLine(
		line: Line,
		atColumnNumber: number,
	): FormFeed {
		const { range } = line;


		return new FormFeed(new Range(
			range.startLineNumber,
			atColumnNumber,
			range.startLineNumber,
			atColumnNumber + this.symbol.length,
		));
	}

	/**
	 * Returns a string representation of the token.
	 */
	public override toString(): string {
		return `formfeed${this.range}`;
	}
}
