import { createGateway } from '../server/app.js';
import { gatewayConfig } from '../server/config.js';

export default createGateway(gatewayConfig());