import { routeAgentRequest } from "agents";

export { ResearchAgent } from "./agents/research-agent";
export { ResearchWorkflow } from "./workflows/research-workflow";

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
