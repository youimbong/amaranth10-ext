// Teams Workflows/Incoming Webhook 공통으로 받는 Adaptive Card 메시지.
export function buildTeamsPayload({ title, content, url }) {
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true },
          { type: 'TextBlock', text: content, wrap: true },
        ],
        actions: [{ type: 'Action.OpenUrl', title: '아마란스10에서 열기', url }],
      },
    }],
  };
}
