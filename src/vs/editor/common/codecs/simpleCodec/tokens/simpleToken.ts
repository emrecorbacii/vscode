/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Range } from '../../../core/range.js';
import { BaseToken } from '../../baseToken.js';
import { Line } from '../../linesCodec/tokens/line.js';

/**
 * Interface for a class that can be instantiated into a {@link SimpleToken}.
 */
export interface ISimpleTokenClass<TSimpleToken extends SimpleToken> {
	/**
	 * Character representing the token.
	 */
	readonly symbol: string;

	/**
	 * Constructor for the token.
	 */
	new(...args: any[]): TSimpleToken;
}

/**
 * Base class for all "simple" tokens with a `range`.
 * A simple token is the one that represents a single character.
 */
export abstract class SimpleToken extends BaseToken {
	/**
	 * The underlying symbol of the token.
	 */
	public static readonly symbol: string;

	/**
	 * Return text representation of the token.
	 */
	public abstract override get text(): string;

	/**
	 * Create new token instance with range inside
	 * the given `Line` at the given `column number`.
	 */
	public static newOnLine<TSimpleToken extends SimpleToken>(
		line: Line,
		atColumnNumber: number,
		Constructor: ISimpleTokenClass<TSimpleToken>,
	): SimpleToken {
		const { range } = line;

		return new Constructor(new Range(
			range.startLineNumber,
			atColumnNumber,
			range.startLineNumber,
			atColumnNumber + Constructor.symbol.length,
		));
	}
}
