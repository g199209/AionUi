import { describe, expect, it } from 'vitest';
import { buildTeammatePrompt } from '@process/team/prompts/teammatePrompt';
import type { TeamAgent } from '@process/team/types';

function makeAgent(overrides: Partial<TeamAgent> = {}): TeamAgent {
  return {
    slotId: 'slot-1',
    conversationId: 'conv-1',
    role: 'teammate',
    agentType: 'gemini',
    agentName: 'Researcher',
    conversationType: 'gemini',
    status: 'idle',
    ...overrides,
  };
}

describe('buildTeammatePrompt', () => {
  it('keeps greeting replies friendly and focused on role introduction', () => {
    const prompt = buildTeammatePrompt({
      agent: makeAgent(),
      leader: makeAgent({ slotId: 'slot-lead', role: 'leader', agentName: 'Leader', agentType: 'claude' }),
      teammates: [],
    });

    expect(prompt).toContain('If the user greets you, starts a new chat, or asks what you can do');
    expect(prompt).toContain('Briefly introduce yourself and your role on the team');
    expect(prompt).toContain('invite the user to share what they need');
    expect(prompt).toContain('Do NOT open with task board details, idle/waiting status, or coordination mechanics');
  });

  it('tells teammates to send results before marking tasks completed', () => {
    const prompt = buildTeammatePrompt({
      agent: makeAgent(),
      leader: makeAgent({ slotId: 'slot-lead', role: 'leader', agentName: 'Leader', agentType: 'claude' }),
      teammates: [],
    });

    const sendResultIndex = prompt.indexOf('5. When done, use team_send_message to report your concrete results to the leader');
    const markCompletedIndex = prompt.indexOf('6. After sending the result, use team_task_update to mark the task "completed"');

    expect(sendResultIndex).toBeGreaterThanOrEqual(0);
    expect(markCompletedIndex).toBeGreaterThan(sendResultIndex);
    expect(prompt).toContain('Never end your turn after marking a task completed without first sending the result to the leader');
  });
});
