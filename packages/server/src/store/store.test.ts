import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'autoreg-store-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sampleTarget = {
  term: '202701',
  subject: 'COMP',
  faculty: 'Faculty of Science',
  courseNumber: '551',
  targetCrn: '1814',
  mode: 'auto' as const,
};

describe('Store', () => {
  it('adds a target with generated id and default status', () => {
    const s = new Store(dir);
    const t = s.addTarget(sampleTarget);
    expect(t.id).toBeTruthy();
    expect(t.status).toBe('watching');
    expect(s.listTargets()).toHaveLength(1);
  });

  it('rejects a target missing a required field', () => {
    const s = new Store(dir);
    expect(() => s.addTarget({ ...sampleTarget, targetCrn: '' })).toThrow(/targetCrn/);
    expect(() => s.addTarget({ ...sampleTarget, term: '  ' })).toThrow(/term/);
    expect(() => s.addTarget({ ...sampleTarget, faculty: '' })).toThrow(/faculty/);
  });

  it('updates and removes targets', () => {
    const s = new Store(dir);
    const t = s.addTarget(sampleTarget);
    s.updateTarget(t.id, { status: 'registered' });
    expect(s.getTarget(t.id)?.status).toBe('registered');
    s.removeTarget(t.id);
    expect(s.listTargets()).toHaveLength(0);
  });

  it('persists across instances', () => {
    new Store(dir).addTarget(sampleTarget);
    expect(new Store(dir).listTargets()).toHaveLength(1);
  });

  it('caps the event log to maxEvents (newest kept)', () => {
    const s = new Store(dir, { maxEvents: 5 });
    for (let i = 0; i < 12; i++) s.appendEvent({ level: 'info', message: `e${i}` });
    const ev = s.recentEvents(100);
    expect(ev).toHaveLength(5);
    expect(ev[ev.length - 1].message).toBe('e11');
    expect(ev[0].message).toBe('e7');
  });

  it('returns default settings and persists patches', () => {
    const s = new Store(dir);
    expect(s.getSettings().pollIntervalMinutes).toBe(30);
    expect(s.getSettings().queryBudget).toBe(100);
    s.setSettings({ pollIntervalMinutes: 45 });
    expect(new Store(dir).getSettings().pollIntervalMinutes).toBe(45);
  });

  it('tracks daily ops and resets on local date change', () => {
    const day1 = new Date('2026-06-02T10:00:00').getTime();
    const day2 = new Date('2026-06-03T10:00:00').getTime();
    const s = new Store(dir);
    s.incrementQuery(day1);
    s.incrementQuery(day1);
    s.incrementRegister(day1);
    expect(s.getDailyOps(day1)).toMatchObject({ queryCount: 2, registerCount: 1 });
    expect(s.getDailyOps(day2)).toMatchObject({ queryCount: 0, registerCount: 0 });
  });

  it('backs up corrupt store.json to .corrupt and starts fresh', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'autoreg-corrupt-'));
    const storeFile = join(storeDir, 'store.json');
    writeFileSync(storeFile, '{{{ bad json {{{');
    const s = new Store(storeDir);
    // should start fresh — no targets
    expect(s.listTargets()).toHaveLength(0);
    // corrupt file should be renamed
    expect(existsSync(join(storeDir, 'store.json.corrupt'))).toBe(true);
    expect(readFileSync(join(storeDir, 'store.json.corrupt'), 'utf8')).toBe('{{{ bad json {{{');
    // store.json is NOT created until first save (load only backs up + returns fresh)
    // should be able to use the store normally after recovery
    s.addTarget(sampleTarget);
    expect(s.listTargets()).toHaveLength(1);
    // now store.json should exist (created by addTarget → save)
    expect(existsSync(storeFile)).toBe(true);
    rmSync(storeDir, { recursive: true, force: true });
  });

  it('getDailyOps is a pure reader — does not write on date rollover', () => {
    const day1 = new Date('2026-06-02T10:00:00').getTime();
    const day2 = new Date('2026-06-03T10:00:00').getTime();
    const s = new Store(dir);
    s.incrementQuery(day1);
    // reading day2 ops should return fresh zeros WITHOUT saving
    const ops = s.getDailyOps(day2);
    expect(ops.queryCount).toBe(0);
    // re-open: day1 data still persists
    const s2 = new Store(dir);
    expect(s2.getDailyOps(day1).queryCount).toBe(1);
  });
});
