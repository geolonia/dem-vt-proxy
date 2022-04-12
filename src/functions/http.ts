import { formatErrorResponse, SimpleHandler } from "@libs/api-gateway";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import * as Accept from "@hapi/accept";
import fetch, { Headers } from "node-fetch";
import { encodeBuffer } from "http-encoding";
import { vector_tile } from "@libs/protobuf";

const metaHandler: SimpleHandler = async (event) => {
  let hostname = `https://${event.requestContext.domainName}`;
  if (process.env.IS_OFFLINE) {
    hostname = 'http://localhost:3000';
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      "tilejson": "3.0.0",
      "tiles": [
        `${hostname}/dem5a/tiles/{z}/{x}/{y}.mvt`,
      ],
      "vector_layers": [],
      "maxzoom": 0,
      "minzoom": 15,
      "name": "dem5a",
    }),
    headers: {
      'content-type': 'application/json',
    },
  };
};

const tileHandler: SimpleHandler = async (event) => {
  const headers = new Headers(event.headers);

  const { x, y: origY, z } = event.pathParameters;
  const [ y, ] = origY.split(".");
  const xInt = parseInt(x, 10);
  const yInt = parseInt(y, 10);
  const zInt = parseInt(z, 10);

  let demUrl = `https://cyberjapandata.gsi.go.jp/xyz/dem/${zInt}/${xInt}/${yInt}.txt`;
  if (zInt <= 14) {
    demUrl = `https://cyberjapandata.gsi.go.jp/xyz/dem5a/${zInt}/${xInt}/${yInt}.txt`;
  }

  const demResp = await fetch(demUrl);
  if (demResp.status === 404) {
    return formatErrorResponse(204, '');
  }
  if (!demResp.ok) {
    return formatErrorResponse();
  }
  const demData = await demResp.text();

  const features: vector_tile.Tile.IFeature[] = [];
  const keys: string[] = ["ele"];
  const values: vector_tile.Tile.IValue[] = [];
  const parsedData = demData.split('\n').map((x) => x.split(',').map((x) => x.trim()));

  const zz = (value: number) => (value << 1) ^ (value >> 31);

  for (const [rowIdx, row] of parsedData.entries()) {
    for (const [colIdx, col] of row.entries()) {
      if (col === 'e' || col === '') {
        continue;
      }
      let thisValueIndex = values.findIndex((v) => v.stringValue === col);
      if (thisValueIndex === -1) {
        thisValueIndex = values.push({stringValue: col}) - 1;
      }

      features.push({
        id: (rowIdx << 16) ^ (colIdx),
        type: vector_tile.Tile.GeomType.POLYGON,
        geometry: [
          ((1 & 0x7) | (1 << 3)), // MoveTo for 1
            zz(colIdx), zz(rowIdx),
          ((2 & 0x7) | (3 << 3)), // LineTo for 3
            zz(1),  zz(0),
            zz(0),  zz(1),
            zz(-1), zz(0),
          15, // close path
        ],
        tags: [
          0,
          thisValueIndex,
        ]
      });
    }
  }

  const tile = vector_tile.Tile.create({
    layers: [
      {
        version: 2,
        name: "dem",
        extent: 256,
        features: features,
        keys,
        values,
      }
    ]
  })

  // https://maps.gsi.go.jp/development/ichiran.html#dem
  // make request to https://cyberjapandata.gsi.go.jp/xyz/dem5a/{z}/{x}/{y}.txt
  // format description https://maps.gsi.go.jp/development/demtile.html
  // parse request, generate cubes
  // assemble pbf, send to client

  const resolvedEncoding = Accept.encoding(headers.get('accept-encoding'), ['zstd', 'br', 'deflate', 'gzip']) as "zstd" | "br" | "deflate" | "gzip" | "";

  const respHeaders: { [key: string]: string } = {
    'content-type': 'application/vnd.mapbox-vector-tile',
    // 'cache-control': 'no-cache',
    'cache-control': 'public, max-age=3600',
  };

  const buffer = vector_tile.Tile.encode(tile).finish() as Buffer;

  let encodedBuffer = buffer;
  if (resolvedEncoding !== "") {
    encodedBuffer = await encodeBuffer(buffer, resolvedEncoding);
    respHeaders['vary'] = 'accept-encoding';
    respHeaders['content-encoding'] = resolvedEncoding;
  }


  return {
    statusCode: 200,
    isBase64Encoded: true,
    headers: respHeaders,
    body: encodedBuffer.toString('base64'),
  };
};

export const main: APIGatewayProxyHandlerV2 = async (event) => {
  if (event.routeKey === 'GET /dem5a/tiles.json') {
    return await metaHandler(event);
  } else if (event.routeKey === 'GET /dem5a/tiles/{z}/{x}/{y}') {
    return await tileHandler(event);
  }

  return formatErrorResponse(404, "not found");
};
