import * as core from '@actions/core';
import * as path from 'path';
import fs from 'fs';
import * as glob from '@actions/glob';
import { loadActivities, generateDiff, Table, generateActivityDiff } from './diff';
import { setIntersection, setSubtract, setUnion } from './set';

// git diff 5f92d0ba63f6031189e16c87d591a9500701b523...2f3be3b6145ab7099db73e727bf4b02696292f66
// git show 5f92d0ba63f6031189e16c87d591a9500701b523:activities.csv
// use child-process to exec git commands
// https://github.com/sergeyt/parse-diff
// write markdown report to $GITHUB_STEP_SUMMARY

function logGroup(files: Set<string>, message: string, isError: boolean) {
  if (files.size > 0) {
    core.startGroup(message);
    for (const filename of files) {
      isError ? core.error(filename) : core.info(filename);
    }
    core.endGroup();
  }
}

function getReferencedTaskFiles(records: Table): Set<string> {
  const files = new Set<string>();
  for (let i = 0; i < records.length; i++) {
    const record: { [id: string]: string } = records[i];
    if ('Action Link' in record && record['Action Link']) {
      files.add(record['Action Link']);
    }
  }
  return files;
}

async function getTaskFiles(rootDir: string): Promise<Set<string>> {
  const files = new Set<string>();
  const globber = await glob.create(path.join(rootDir, 'tasks/*.json'));
  const matches = await globber.glob();
  for (const file of matches) {
    files.add(core.toPosixPath(path.relative(rootDir, file)));
  }
  return files;
}

async function getMediaFiles(rootDir: string): Promise<Set<string>> {
  const files = new Set<string>();
  const globber = await glob.create(path.join(rootDir, 'video/*'));
  const matches = await globber.glob();
  for (const file of matches) {
    files.add(core.toPosixPath(path.relative(rootDir, file)));
  }
  return files;
}

function getReferencedMediaFiles(
  rootDir: string,
  taskFiles: Set<string>,
): { [taskFile: string]: Set<string> } {
  const taskFileReferences: { [taskFile: string]: Set<string> } = {};
  for (const taskFile of taskFiles) {
    const files = new Set<string>();
    const absolutePath = path.join(rootDir, core.toPlatformPath(taskFile));
    const taskInfo = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
    for (let i = 0; i < taskInfo['steps'].length; i++) {
      const step = taskInfo['steps'][i];
      if ('videoUrl' in taskInfo['steps'][i]) {
        files.add(decodeURI(step['videoUrl']));
      }
      if ('audioUrl' in taskInfo['steps'][i]) {
        files.add(decodeURI(step['audioUrl']));
      }
    }
    taskFileReferences[taskFile] = files;
  }
  return taskFileReferences;
}

export async function run(): Promise<void> {
  try {
    const githubWorkspace = process.env.GITHUB_WORKSPACE;
    const githubStepSummary = process.env.GITHUB_STEP_SUMMARY;
    const csvPath = core.getInput('csv', { required: true });
    const magicTasks = core.getInput('magic_tasks');
    const gitBaseSha = core.getInput('git_base_sha');
    const gitHeadSha = core.getInput('git_head_sha');
    if (!githubWorkspace) {
      throw new Error(`$GITHUB_WORKSPACE is not set`);
    }
    const absoluteRoot = path.resolve(githubWorkspace);
    const csvPlatformPath = core.toPlatformPath(csvPath);
    const baseActivities = gitBaseSha
      ? await loadActivities(absoluteRoot, csvPlatformPath, gitBaseSha)
      : undefined;

    if (gitBaseSha && gitHeadSha) {
      await generateDiff(absoluteRoot, gitBaseSha, gitHeadSha);
    }

    const headActivities = await loadActivities(absoluteRoot, csvPlatformPath);
    const taskFiles = await getTaskFiles(absoluteRoot);
    const usedTaskFiles = getReferencedTaskFiles(headActivities);
    const taskFilesIntersection = setIntersection(usedTaskFiles, taskFiles);
    const usedMediaFileReferences = getReferencedMediaFiles(absoluteRoot, taskFilesIntersection);
    if (baseActivities) {
      const activityDiffMarkdown = await generateActivityDiff(
        baseActivities,
        headActivities,
        usedMediaFileReferences,
        absoluteRoot,
        gitBaseSha,
        gitHeadSha,
      );
      if (!githubStepSummary) {
        console.log(`$GITHUB_STEP_SUMMARY is not set`);
        console.log(activityDiffMarkdown);
      }
      await core.summary.addRaw(activityDiffMarkdown).write();
    }
    for (const element of magicTasks.split(',')) {
      if (element) {
        usedTaskFiles.add(element);
      }
    }

    const missingTaskFiles = setSubtract(usedTaskFiles, taskFiles);
    const unusedTaskFiles = setSubtract(taskFiles, usedTaskFiles);

    const mediaFiles = await getMediaFiles(absoluteRoot);

    const usedMediaFiles = Object.values(usedMediaFileReferences).reduce(
      (accum, current) => setUnion(accum, current),
      new Set<string>(),
    );
    const missingMediaFiles = setSubtract(usedMediaFiles, mediaFiles);
    const unusedMediaFiles = setSubtract(mediaFiles, usedMediaFiles);

    logGroup(missingTaskFiles, 'Missing task files', true);
    logGroup(unusedTaskFiles, 'Unused task files', false);

    logGroup(missingMediaFiles, 'Missing media files', true);
    logGroup(unusedMediaFiles, 'Unused media files', false);

    if (missingTaskFiles.size > 0 || missingMediaFiles.size > 0) {
      core.setFailed(`ubik2/check-references-action failed with missing files`);
    }
  } catch (err) {
    core.setFailed(`ubik2/check-references-action failed with: ${err}`);
  }
}

// Execute this as the entrypoint when requested.
if (require.main === module) {
  run();
}
