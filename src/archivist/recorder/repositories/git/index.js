/**
 * This module is the boundary beyond which the usage of git is abstracted.
 * Commit SHAs are used as opaque unique IDs.
 */

import fsApi from 'fs';

import mime from 'mime';

import RepositoryInterface from '../interface.js';

import * as DataMapper from './dataMapper.js';
import Git from './git.js';

const fs = fsApi.promises;

mime.define({ 'text/markdown': ['md'] }, true); // ensure extension for markdown files is `.md` and not `.markdown`

export default class GitRepository extends RepositoryInterface {
  constructor({ path, author, publish, prefixMessageToSnapshotId }) {
    super();
    this.path = path;
    this.needsPublication = publish;
    this.git = new Git({ path: this.path, author });
    this.prefixMessageToSnapshotId = prefixMessageToSnapshotId;
  }

  async initialize() {
    await this.git.initialize();
    await this.git.cleanUp(); // Drop all uncommitted changes and remove all leftover files that may be present if the process was killed aggressively

    return this;
  }

  async save(record) {
    const { serviceId, documentType, fetchDate } = record;

    if (record.isFirstRecord === undefined || record.isFirstRecord === null) {
      record.isFirstRecord = await this.#isFirstRecord(serviceId, documentType);
    }
    const { message, content, fileExtension } = await this.#toPersistence(record);

    const filePath = await this.#writeFile({ serviceId, documentType, content, fileExtension });
    const sha = await this.#commit({ filePath, message, date: fetchDate });

    if (!sha) {
      return Object(null);
    }

    record.id = sha;

    return record;
  }

  finalize() {
    if (!this.needsPublication) {
      return;
    }

    return this.git.pushChanges();
  }

  async findLatest(serviceId, documentType) {
    const commit = await this.git.getCommit([`${serviceId}/${documentType}.*`]);

    return this.#toDomain(commit);
  }

  async findById(recordId) {
    const commit = await this.git.getCommit([recordId]);

    return this.#toDomain(commit);
  }

  async findAll() {
    return Promise.all((await this.#getCommits()).map(commit => this.#toDomain(commit, { deferContentLoading: true })));
  }

  async count() {
    return (await this.git.log([
      `--grep=${DataMapper.COMMIT_MESSAGE_PREFIX.startTracking}`,
      `--grep=${DataMapper.COMMIT_MESSAGE_PREFIX.refilter}`,
      `--grep=${DataMapper.COMMIT_MESSAGE_PREFIX.update}`,
    ])).length;
  }

  async* iterate() {
    const commits = await this.#getCommits();

    for (const commit of commits) {
      yield this.#toDomain(commit);
    }
  }

  async removeAll() {
    return this.git.destroyHistory();
  }

  async loadRecordContent(record) {
    const relativeFilePath = `${record.serviceId}/${record.documentType}.${mime.getExtension(record.mimeType)}`;

    if (record.mimeType != mime.getType('pdf')) {
      record.content = await this.git.show(`${record.id}:${relativeFilePath}`);

      return;
    }

    // In case of PDF files, `git show` cannot be used as it converts PDF binary into strings that do not retain the original binary representation
    // It is impossible to restore the original binary data from the resulting string
    let pdfBuffer;

    try {
      await this.git.restore(relativeFilePath, record.id); // Temporarily restore the PDF file to a specific commit
      pdfBuffer = await fs.readFile(`${this.path}/${relativeFilePath}`); // …read the content
    } finally {
      await this.git.restore(relativeFilePath, 'HEAD'); // …and finally restore the file to its most recent state
    }

    record.content = pdfBuffer;
  }

  async #getCommits() {
    return (await this.git.listCommits())
      .filter(({ message }) => message.match(DataMapper.COMMIT_MESSAGE_PREFIXES_REGEXP)) // Skip commits which are not a document record (README, LICENSE…)
      .sort((commitA, commitB) => new Date(commitA.date) - new Date(commitB.date)); // Make sure that the commits are sorted in ascending chronological order
  }

  async #writeFile({ serviceId, documentType, content, fileExtension }) {
    const directory = `${this.path}/${serviceId}`;

    if (!fsApi.existsSync(directory)) {
      await fs.mkdir(directory, { recursive: true });
    }

    const filePath = `${this.path}/${serviceId}/${documentType}.${fileExtension}`;

    await fs.writeFile(filePath, content);

    return filePath;
  }

  async #commit({ filePath, message, date }) {
    try {
      await this.git.add(filePath);

      return await this.git.commit({ filePath, message, date });
    } catch (error) {
      throw new Error(`Could not commit ${filePath} with message "${message}" due to error: "${error}"`);
    }
  }

  async #isFirstRecord(serviceId, documentType) {
    const filePattern = `${this.path}/${serviceId}/${documentType}.*`;

    return !await this.git.isTracked(filePattern);
  }

  async #toDomain(commit, { deferContentLoading } = {}) {
    if (!commit) {
      return Object(null);
    }

    const record = DataMapper.toDomain(commit);

    if (deferContentLoading) {
      return record;
    }

    await this.loadRecordContent(record);

    return record;
  }

  async #toPersistence(record) {
    if (record.content === undefined || record.content === null) {
      await this.loadRecordContent(record);
    }

    return DataMapper.toPersistence(record, this.prefixMessageToSnapshotId);
  }
}
