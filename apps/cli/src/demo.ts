export const demoScenario = `
version: 1
name: deterministic-interaction-lifecycle
description: Demonstrates an immediate response, a late response, permission denial, and rate limiting.
seed: 42042
mode: strict
initialState:
  guilds:
    - id: "1000"
      name: Foundation Lab
  channels:
    - id: "2000"
      guildId: "1000"
      name: bot-testing
actions:
  - at: 0
    type: interaction
    command: ping
    acknowledgeAfterMs: 120
  - at: 1000
    type: interaction
    command: slow
    acknowledgeAfterMs: 3420
  - at: 5000
    type: permission-check
    permission: MANAGE_MESSAGES
    expected: denied
  - at: 6000
    type: rest-request
    route: POST /channels/2000/messages
    repeat: 6
assertions:
  - type: interaction-acknowledged
    command: ping
    withinMs: 3000
  - type: risk-detected
    ruleId: INTERACTION_ACK_LATE
  - type: no-secret-leak
`;
