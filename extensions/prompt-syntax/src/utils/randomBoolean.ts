/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * (pseudo)Random boolean generator.
 *
 * ## Examples
 *
 * ```typescript
 * randomBoolean(); // generates either `true` or `false`
 * ```
 *
 */
// TODO: @lego - add unit tests?
export const randomBoolean = (): boolean => {
	return Math.random() > 0.5;
};
