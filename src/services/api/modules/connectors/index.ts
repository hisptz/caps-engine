import { Elysia } from "elysia";
import { ConnectorService } from "@/services/api/modules/connectors/service.ts";
import {
  idParams,
  connectorRunIdParams,
  listConnectorsQuery,
  createConnectorBody,
  updateConnectorBody,
  listConnectorRunsQuery,
} from "@/services/api/modules/connectors/model.ts";

const connectorService = new ConnectorService();

export const connectorsModule = new Elysia({ prefix: "/connectors", tags: ["Connectors"] })
  .get("/", ({ query }) => connectorService.listConnectors(query), {
    query: listConnectorsQuery,
    detail: {
      summary: "List pipeline connectors",
      description: "List connectors, optionally those where a pipeline is the source or the target",
      operationId: "listConnectors",
      responses: { "200": { description: "Connector list" } },
    },
  })
  .post(
    "/",
    ({ body, set }) => {
      set.status = 201;
      return connectorService.createConnector(body);
    },
    {
      body: createConnectorBody,
      detail: {
        summary: "Create pipeline connector",
        description:
          "Start a target pipeline when a source pipeline finishes and the connector's rule is met",
        operationId: "createConnector",
        responses: {
          "201": { description: "Created connector" },
          "400": { description: "Validation error or invalid rule" },
          "404": { description: "Source or target pipeline not found" },
          "409": { description: "Connector would create a loop" },
        },
      },
    }
  )
  .get("/:id", ({ params }) => connectorService.getConnector(params.id), {
    params: idParams,
    detail: {
      summary: "Get pipeline connector",
      operationId: "getConnector",
      responses: {
        "200": { description: "Connector detail" },
        "404": { description: "Connector not found" },
      },
    },
  })
  .put("/:id", ({ params, body }) => connectorService.updateConnector(params.id, body), {
    params: idParams,
    body: updateConnectorBody,
    detail: {
      summary: "Update pipeline connector",
      description: "Partially update a connector; the source pipeline cannot change",
      operationId: "updateConnector",
      responses: {
        "200": { description: "Updated connector" },
        "400": { description: "Validation error or invalid rule" },
        "404": { description: "Connector or target pipeline not found" },
        "409": { description: "Connector would create a loop" },
      },
    },
  })
  .delete("/:id", ({ params }) => connectorService.deleteConnector(params.id), {
    params: idParams,
    detail: {
      summary: "Delete pipeline connector",
      description: "Delete a connector and its run history",
      operationId: "deleteConnector",
      responses: {
        "200": { description: "Deleted connector" },
        "404": { description: "Connector not found" },
      },
    },
  })
  .get("/:id/runs", ({ params, query }) => connectorService.listConnectorRuns(params.id, query), {
    params: idParams,
    query: listConnectorRunsQuery,
    detail: {
      summary: "List connector runs",
      description: "Paginated decisions this connector made, newest first",
      operationId: "listConnectorRuns",
      responses: {
        "200": { description: "Paginated connector runs" },
        "404": { description: "Connector not found" },
      },
    },
  })
  .post("/runs/:id/cancel", ({ params }) => connectorService.cancelConnectorRun(params.id), {
    params: connectorRunIdParams,
    detail: {
      summary: "Cancel connector run",
      description: "Stop a connector run that is still waiting to be evaluated",
      operationId: "cancelConnectorRun",
      responses: {
        "200": { description: "Cancelled connector run" },
        "404": { description: "Connector run not found" },
        "409": { description: "Connector run already decided" },
      },
    },
  });
