// Escolhe de onde o agente lê os dados do gateway.
import { config } from "./config.js";
import { httpGatewayData, mockGatewayData, type GatewayData } from "./gateway-data.js";

export const gatewayData: GatewayData = config.gatewayApiUrl
  ? httpGatewayData(config.gatewayApiUrl, config.gatewayApiToken)
  : mockGatewayData;

if (!config.gatewayApiUrl) {
  console.warn("⚠️  GATEWAY_API_URL não definida: usando DADOS DE EXEMPLO. Não use assim em produção.");
}
