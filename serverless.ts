import type { AWS } from '@serverless/typescript';

const serverlessConfiguration: AWS = {
  service: 'dem-vt-proxy',
  frameworkVersion: '3',
  plugins: [
    'serverless-esbuild',
    'serverless-offline',
  ],
  provider: {
    name: 'aws',
    runtime: 'nodejs14.x',
    memorySize: 512,
    timeout: 20,
    region: 'ap-northeast-1',
    stage: "${opt:stage, 'dev'}",
    apiGateway: {
      minimumCompressionSize: 1024,
      shouldStartNameWithService: true,
    },
    environment: {
      STAGE: '${self:provider.stage}',
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      NODE_OPTIONS: '--enable-source-maps --stack-trace-limit=1000',
    },
    deploymentBucket: {
      name: 'geolonia-slsdeploymentbucket-${self:provider.region}',
    },
    logRetentionInDays: 30,
    versionFunctions: false,
    httpApi: {
      cors: true,
    },
    endpointType: 'REGIONAL',
  },
  // import the function via paths
  functions: {
    http: {
      handler: `src/functions/http.main`,
      events: [
        {
          httpApi: {
            method: 'get',
            path: '/dem5a/tiles.json'
          }
        },
        {
          httpApi: {
            method: 'get',
            path: '/dem5a/tiles/{z}/{x}/{y}'
          }
        }
      ]
    }
  },
  package: { individually: true },
  custom: {
    esbuild: {
      bundle: true,
      minify: false,
      sourcemap: true,
      exclude: ['aws-sdk'],
      target: 'node14',
      define: { 'require.resolve': undefined },
      platform: 'node',
      concurrency: 10,
      packager: 'yarn',
      external: [],
    },
  },
};

module.exports = serverlessConfiguration;
