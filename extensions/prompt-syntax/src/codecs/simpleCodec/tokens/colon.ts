/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BaseToken } from '../../baseToken';
import { Range } from '../../../utils/vscode';
import { Line } from '../../linesCodec/tokens';

/**
 * A token that represent a `:` with a `range`. The `range`
 * value reflects the position of the token in the original data.
 */
export class Colon extends BaseToken {
	/**
	 * The underlying symbol of the token.
	 */
	public static readonly symbol: string = ':';

	/**
	 * Return text representation of the token.
	 */
	public get text(): string {
		return Colon.symbol;
	}

	/**
	 * Create new token with range inside
	 * the given `Line` at the given `column number`.
	 */
	public static newOnLine(
		line: Line,
		atColumnNumber: number,
	): Colon {
		const { range } = line;

		return new Colon(new Range(
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
		return `colon${this.range}`;
	}
}
