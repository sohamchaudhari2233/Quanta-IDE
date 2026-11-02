/**
 * Example Quanta IDE Plugin: Slack / Webhook Notifier
 * Demonstrates the Plugin Host API, EventBus hooks, and custom quick action registration.
 */

export default {
  name: 'slack-notifier',
  version: '1.0.0',

  async init(context) {
    context.log('Initializing Slack Notifier Plugin...');

    // 1. Listen for approval requests and log/alert
    context.eventBus.on('approval:requested', (approval) => {
      context.log(`Slack alert dispatched: Action [${approval.action}] requires approval (Risk: ${approval.risk})`);
      context.auditLogger.log('ALERT_EMITTED', { approvalId: approval.id });
    });

    // 2. Register custom quick action accessible from phone UI
    context.registerQuickAction({
      id: 'ping-team',
      name: 'Ping Team on Slack',
      description: 'Sends a status update ping to the team channel',
      risk: 'safe',
      handler: async () => {
        context.log('Team pinged successfully.');
        return { success: true, message: 'Team pinged via Slack integration' };
      }
    });

    context.log('Slack Notifier Plugin ready.');
  },

  async dispose() {
    console.log('[Plugin:slack-notifier] Disposed.');
  }
};

