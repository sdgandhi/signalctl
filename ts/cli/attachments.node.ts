// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile, stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';

import heicConvert from 'heic-convert';

import type { AttachmentType } from '../types/Attachment.std.ts';
import {
  APPLICATION_OCTET_STREAM,
  IMAGE_JPEG,
  isHeic,
  stringToMIMEType,
  type MIMEType,
} from '../types/MIME.std.ts';
import { sniffImageMimeType } from '../util/sniffImageMimeType.std.ts';

async function readBytes(path: string): Promise<Uint8Array<ArrayBuffer>> {
  const buffer = await readFile(path);
  return new Uint8Array(buffer) as Uint8Array<ArrayBuffer>;
}

function jpegNameFromHeic(path: string): string {
  const fileName = basename(path);
  return `${fileName.slice(0, fileName.length - extname(fileName).length)}.jpg`;
}

const MIME_TYPES_BY_EXTENSION = new Map<string, MIMEType>(
  Object.entries({
    '.aac': 'audio/aac',
    '.avi': 'video/x-msvideo',
    '.bmp': 'image/bmp',
    '.csv': 'text/csv',
    '.doc': 'application/msword',
    '.docx':
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.gif': 'image/gif',
    '.htm': 'text/html',
    '.html': 'text/html',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.json': 'application/json',
    '.m4a': 'audio/mp4',
    '.md': 'text/markdown',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.mpeg': 'video/mpeg',
    '.mpg': 'video/mpeg',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx':
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.rtf': 'application/rtf',
    '.svg': 'image/svg+xml',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.tsv': 'text/tab-separated-values',
    '.txt': 'text/plain',
    '.wav': 'audio/wav',
    '.webm': 'video/webm',
    '.webp': 'image/webp',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx':
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xml': 'application/xml',
    '.zip': 'application/zip',
  }).map(([extension, mimeType]) => [extension, stringToMIMEType(mimeType)])
);

function getMimeTypeForPath(
  path: string,
  data: Uint8Array<ArrayBuffer>
): MIMEType {
  const sniffedImageType = sniffImageMimeType(data);
  if (sniffedImageType) {
    return sniffedImageType;
  }

  return (
    MIME_TYPES_BY_EXTENSION.get(extname(path).toLowerCase()) ??
    APPLICATION_OCTET_STREAM
  );
}

export async function createAttachmentFromPath(
  path: string
): Promise<AttachmentType> {
  const absolutePath = resolve(path);
  const fileStats = await stat(absolutePath);
  if (!fileStats.isFile()) {
    throw new Error(`Attachment path is not a file: ${path}`);
  }

  const fileName = basename(absolutePath);
  const data = await readBytes(absolutePath);

  if (isHeic('', fileName)) {
    const converted = await heicConvert({
      buffer: data,
      format: 'JPEG',
      quality: 0.85,
    });
    return {
      contentType: IMAGE_JPEG,
      data: converted,
      fileName: jpegNameFromHeic(absolutePath),
      size: converted.byteLength,
    };
  }

  return {
    contentType: getMimeTypeForPath(absolutePath, data),
    data,
    fileName,
    size: data.byteLength,
  };
}

export async function createAttachmentsFromPaths(
  paths: ReadonlyArray<string>
): Promise<Array<AttachmentType>> {
  return Promise.all(paths.map(createAttachmentFromPath));
}
