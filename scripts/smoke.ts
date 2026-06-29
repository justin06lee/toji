import { predictIntent } from '../apps/agent-server/src/agents/predictionAgent.js';

const prediction = await predictIntent('research Cerebras Gemma 4 browser agents');
console.log(JSON.stringify(prediction, null, 2));
