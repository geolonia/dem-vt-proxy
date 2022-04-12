import {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";

export type SimpleHandler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>;

export const formatErrorResponse = (statusCode = 500, errorMessage = "Internal Server Error") => {
  return {
    statusCode,
    body: errorMessage,
  };
};
