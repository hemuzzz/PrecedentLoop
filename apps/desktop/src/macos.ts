import { z } from "zod";
import { executeFile } from "./config.js";

const runningSchema = z.array(z.object({ pid: z.number().int(), path: z.string(), bundleId: z.string() }));
export async function runningApplications(): Promise<z.infer<typeof runningSchema>> {
  const { stdout } = await executeFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", `
    ObjC.import('AppKit');
    const result=[]; const apps=$.NSWorkspace.sharedWorkspace.runningApplications;
    for(let i=0;i<apps.count;i++){ const app=apps.objectAtIndex(i);
      const path=ObjC.unwrap(app.bundleURL.path), bundleId=ObjC.unwrap(app.bundleIdentifier);
      if(typeof path==='string' && typeof bundleId==='string') result.push({pid:Number(app.processIdentifier),path,bundleId});
    } JSON.stringify(result);
  `]);
  return runningSchema.parse(JSON.parse(stdout));
}
export async function processIdentity(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await executeFile("/bin/ps", ["-p", String(pid), "-o", "lstart=,command="]);
    return stdout.trim() || undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === 1 && "stdout" in error && String(error.stdout).trim() === "") return undefined;
    throw error;
  }
}
export async function backendProcesses(entry: string): Promise<{ pid: number; ppid: number }[]> {
  const { stdout } = await executeFile("/bin/ps", ["-axo", "pid=,ppid=,command="], { maxBuffer: 8 * 1024 * 1024 });
  return stdout.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match && match[3]?.includes(entry) ? [{ pid: Number(match[1]), ppid: Number(match[2]) }] : [];
  });
}
export async function requestNormalQuit(bundleId: string): Promise<void> {
  // argv avoids interpolating identifiers into AppleScript source.
  await executeFile("/usr/bin/osascript", ["-e", `on run argv
    set appId to item 1 of argv
    tell application id appId to quit
  end run`, bundleId], { timeout: 25000 });
}
