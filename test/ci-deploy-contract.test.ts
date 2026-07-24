// Behavioral-pin lane: Terminus production delivery must remain a fail-closed,
// one-repository/one-machine edge with application revision proof.

import { describe, expect, test } from 'bun:test';

const workflow = await Bun.file(
  new URL('../.github/workflows/deploy-production.yml', import.meta.url),
).text();

describe('production deployment workflow', () => {
  test('runs only after successful main CI and serializes production', () => {
    expect(workflow).toContain('workflow_run:');
    expect(workflow).toContain('workflows: [CI]');
    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).toContain('group: terminus-os-production');
    expect(workflow).toContain('cancel-in-progress: true');
  });

  test('fails closed when credentials or typed target variables are absent', () => {
    expect(workflow).toContain('Credential and target provisioning gate');
    expect(workflow).toContain('TS_OAUTH_CLIENT_ID');
    expect(workflow).toContain('TS_OAUTH_SECRET');
    for (const variable of [
      'K12_PERSONAL_FLEET_HOST',
      'K12_PERSONAL_FLEET_PORT',
      'K12_PERSONAL_FLEET_BASE',
      'K12_PERSONAL_TXD_HEALTH_URL',
    ]) {
      expect(workflow).toContain(`vars.${variable}`);
      expect(workflow).toContain(`${variable}:`);
    }
    expect(workflow).toContain('::error::Terminus production deployment is not provisioned');
    expect(workflow).not.toMatch(/skipping.*credential|credentials.*skip/i);
  });

  test('uses one ack-first converge edge and proves txd application SHA', () => {
    expect(workflow.match(/-X POST/g)).toHaveLength(1);
    expect(workflow).toContain('${K12_PERSONAL_FLEET_BASE}/converge');
    expect(workflow).toContain('acked=true');
    expect(workflow).toContain('potentially-OFF');
    expect(workflow).toContain('/ctl/health');
    expect(workflow).toContain('.git_sha');
    expect(workflow).toContain('github.event.workflow_run.head_sha');
    expect(workflow).not.toMatch(/\b(?:100\.)\d+\.\d+\.\d+\b/);
    expect(workflow).not.toContain('/home/');
  });
});
