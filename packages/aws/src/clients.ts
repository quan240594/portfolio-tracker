import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/** Region and optional endpoint override (LocalStack) shared by every AWS client. */
export interface AwsConnection {
  region: string;
  endpointUrl?: string;
}

export function awsClientConfig({ region, endpointUrl }: AwsConnection): { region: string; endpoint?: string } {
  return { region, ...(endpointUrl ? { endpoint: endpointUrl } : {}) };
}

/** Document client that drops `undefined` attributes instead of rejecting them. */
export function createDocClient(connection: AwsConnection): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient(awsClientConfig(connection)), { marshallOptions: { removeUndefinedValues: true } });
}
