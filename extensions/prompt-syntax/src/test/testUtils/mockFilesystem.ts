/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Uri } from 'vscode';
import { URI } from 'vscode-uri';

import { VSBuffer } from '../../utils/vscode';
import { IFileSystemService } from '../../services/types';

/**
 * Represents a generic file system node.
 */
interface IMockFilesystemNode {
	name: string;
}

/**
 * Represents a `file` node.
 */
export interface IMockFile extends IMockFilesystemNode {
	contents: string;
}

/**
 * Represents a `folder` node.
 */
export interface IMockFolder extends IMockFilesystemNode {
	children: (IMockFolder | IMockFile)[];
}

/**
 * Type for a mocked file or a folder that has absolute path URI.
 */
type TWithURI<T extends IMockFilesystemNode> = T & { uri: URI };

/**
 * Utility to recursively creates provided filesystem structure.
 */
export class MockFilesystem {
	constructor(
		private readonly folders: IMockFolder[],
		private readonly fileService: IFileSystemService,
	) { }

	/**
	 * Starts the mock process.
	 */
	public async mock(): Promise<TWithURI<IMockFolder>[]> {
		return await Promise.all(
			this.folders
				.map((folder) => {
					return this.mockFolder(folder);
				}),
		);
	}

	/**
	 * The internal implementation of the filesystem mocking process.
	 *
	 * @throws If a folder or file in the filesystem structure already exists.
	 * 		   This is to prevent subtle errors caused by overwriting existing files.
	 */
	private async mockFolder(
		folder: IMockFolder,
		parentFolder?: URI,
	): Promise<TWithURI<IMockFolder>> {
		const folderUri = parentFolder
			? Uri.joinPath(parentFolder, folder.name)
			: URI.file(folder.name);

		assert(
			!(await this.fileService.exists(folderUri)),
			`Folder '${folderUri.path}' already exists.`,
		);

		try {
			await this.fileService.createDirectory(folderUri);
		} catch (error) {
			throw new Error(`Failed to create folder '${folderUri.fsPath}': ${error}.`);
		}

		const resolvedChildren: (TWithURI<IMockFolder> | TWithURI<IMockFile>)[] = [];
		for (const child of folder.children) {
			const childUri = Uri.joinPath(folderUri, child.name);
			// create child file
			if ('contents' in child) {
				assert(
					!(await this.fileService.exists(childUri)),
					`File '${folderUri.path}' already exists.`,
				);

				await this.fileService.writeFile(childUri, VSBuffer.fromString(child.contents).buffer);

				resolvedChildren.push({
					...child,
					uri: childUri,
				});

				continue;
			}

			// recursively create child filesystem structure
			resolvedChildren.push(await this.mockFolder(child, folderUri));
		}

		return {
			...folder,
			uri: folderUri,
		};
	}
}
