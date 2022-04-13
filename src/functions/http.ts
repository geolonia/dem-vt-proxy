import { formatErrorResponse, SimpleHandler } from "../libs/api-gateway";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import * as Accept from "@hapi/accept";
import fetch, { Headers } from "node-fetch";
import { encodeBuffer } from "http-encoding";
import { vector_tile } from "../libs/protobuf";

// use this to scale pixels from the source to bigger pixels in the vector tile
// a scale factor of 2 means the input dem 256x256 tile is split into 2**2 (4) output tiles, each with 128x128 pixels each, reducing the zoom by one.
// a scale factor of 3 means each input tile is split into 2**3 (8) tiles, reducing the zoom by 2.
// Note that setting SCALE_FACTOR means that minzoom will be set to SCALE_FACTOR-1, not 0. (DEM postprocessing not implemented yet)
const SCALE_FACTOR = 4;

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
        `${hostname}/jgsi-dem/tiles/{z}/{x}/{y}.mvt`,
      ],
      "vector_layers": [
        {
          "id": "dem",
          "fields": {
            "ele": "String"
          }
        }
      ],
      "minzoom": SCALE_FACTOR - 1,
      "maxzoom": 15 + (SCALE_FACTOR - 1),
      "name": "jgsi-dem",
      "attribution": "<a href=\"https://www.gsi.go.jp/\" target=\"_blank\">&copy; GSI Japan</a>",
    }),
    headers: {
      'content-type': 'application/json',
    },
  };
};

const dem10url = (x: number, y: number, z: number) => `https://cyberjapandata.gsi.go.jp/xyz/dem/${z}/${x}/${y}.txt`;
const dem5aurl = (x: number, y: number, z: number) => `https://cyberjapandata.gsi.go.jp/xyz/dem5a/${z}/${x}/${y}.txt`;

const getDemData = async (demUrl: string) => {
  const demResp = await fetch(demUrl);
  if (demResp.status === 404) {
    return null;
  }
  if (!demResp.ok) {
    return null;
  }
  const demData: string = await demResp.text();
  const parsedData = demData
    .split('\n')
    .map((x) =>
      x
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x !== '')
    );
  return parsedData;
}

const mergedDemDataCache: { [key: string]: string[][] } = {};

const getMergedDemData = async (x: number, y: number, z: number) => {
  const cacheKey = `${z}/${x}/${y}`;
  let output: string[][] = mergedDemDataCache[cacheKey];
  if (output) {
    return output;
  }
  const [
    dem5data,
    dem10data,
  ] = await Promise.all([
    getDemData(dem5aurl(x, y, z)),
    getDemData(dem10url(x, y, z)),
  ]);

  if (dem5data === null) {
    return null;
  }
  output = [...Array(256)].map(_x => Array(256).fill('e'));
  for (const [rowIdx, row] of dem5data.entries()) {
    for (const [colIdx, col] of row.entries()) {
      let val = col;
      if (val === 'e' && dem10data) {
        val = dem10data[rowIdx][colIdx];
      }
      output[rowIdx][colIdx] = val;
    }
  }
  mergedDemDataCache[cacheKey] = output;
  return output;
}

type XYZTile = [number, number, number]; //xyz
// const getParent = (tile: XYZTile, zoom: number) => {
//   const zSteps = Math.max(tile[2] - zoom, 0);
//   return [tile[0] >> zSteps, tile[1] >> zSteps, tile[2] - zSteps];
// }

const TileRelativePositionTruthTable = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
] as const;
type TileRelativePosition = typeof TileRelativePositionTruthTable[number];

function getPositionInParent(tile: XYZTile): [TileRelativePosition, XYZTile] {
  const parent: XYZTile = [tile[0] >> 1, tile[1] >> 1, tile[2] - 1];
  const children: XYZTile[] = [
    [parent[0] * 2, parent[1] * 2, parent[2] + 1],         // 0 = 0, 0
    [parent[0] * 2 + 1, parent[1] * 2, parent[2 ] + 1],    // 1 = 1, 0
    [parent[0] * 2 + 1, parent[1] * 2 + 1, parent[2] + 1], // 2 = 1, 1
    [parent[0] * 2, parent[1] * 2 + 1, parent[2] + 1]      // 3 = 0, 1
  ];
  const indexInParent = children.findIndex(
    ([x,y,z]) => x === tile[0] && y === tile[1] && z === tile[2]
  )
  return [
    TileRelativePositionTruthTable[indexInParent],
    parent,
  ];
}
function getRelativePositionInAncestor(tile: XYZTile, steps: number): [XYZTile, [number, number]] {
  const targetZoom = tile[2] - steps;
  let currentTile = tile;
  // console.log('starting at', tile);
  const relativePositions: TileRelativePosition[] = [];
  while (currentTile[2] > targetZoom) {
    const [
      rp1,
      newTile,
    ] = getPositionInParent(currentTile);
    relativePositions.unshift(rp1);
    // console.log('parent of ^', newTile);
    currentTile = newTile;
  }
  // console.log(relativePositions);
  return [
    currentTile,
    relativePositions.reduce<[number, number]>(
      ([x, y], [x1, y1], idx) => (
        [x + (x1 * 2**((steps-1)-idx)), y + (y1 * 2**((steps-1)-idx))]
      ),
      [0,0]
    )
  ]
}

const zz = (value: number) => (value << 1) ^ (value >> 31);

const tileHandler: SimpleHandler = async (event) => {
  const headers = new Headers(event.headers);

  const { x, y: origY, z } = event.pathParameters;
  const [ y, ] = origY.split(".");
  const xInt = parseInt(x, 10);
  const yInt = parseInt(y, 10);
  const zInt = parseInt(z, 10);

  const features: vector_tile.Tile.IFeature[] = [];
  const keys: string[] = ["ele"];
  const values: vector_tile.Tile.IValue[] = [];

  const [
    parentTile,
    [relX, relY],
  ] = getRelativePositionInAncestor([xInt, yInt, zInt], SCALE_FACTOR-1);

  // console.log('scaling', [xInt, yInt, zInt], 'with scale factor', SCALE_FACTOR, 'results in', [relX, relY]);
  const tileSize = (256 / (2**(SCALE_FACTOR-1)));

  // GSI only has data up to z15
  // const dataZ = Math.min(zInt + 1, 15);
  const demData = await getMergedDemData(parentTile[0], parentTile[1], parentTile[2]);
  if (!demData) {
    return formatErrorResponse(204, '');
  }

  for (let rawRowIdx = 0; rawRowIdx < tileSize; rawRowIdx++) {
    // translate the raw row index to the mapped row index within the tile we have requested
    const rowIdx = rawRowIdx + (tileSize * relY);
    const row = demData[rowIdx];
    for (let rawColIdx = 0; rawColIdx < tileSize; rawColIdx++) {
      const colIdx = rawColIdx + (tileSize * relX);
      const val = row[colIdx];
      if (val === 'e') {
        continue;
      }
      let thisValueIndex = values.findIndex((v) => v.stringValue === val);
      if (thisValueIndex === -1) {
        thisValueIndex = values.push({stringValue: val}) - 1;
      }

      features.push({
        id: (rowIdx << 16) ^ (colIdx),
        type: vector_tile.Tile.GeomType.POLYGON,
        geometry: [
          ((1 & 0x7) | (1 << 3)), // MoveTo for 1
            zz(rawColIdx), zz(rawRowIdx),
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
        extent: 256 / (2**(SCALE_FACTOR-1)),
        features: features,
        keys,
        values,
      }
    ]
  });

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
    // 'cache-control': 'public, max-age=30',
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
  if (event.routeKey === 'GET /jgsi-dem/tiles.json') {
    return await metaHandler(event);
  } else if (event.routeKey === 'GET /jgsi-dem/tiles/{z}/{x}/{y}') {
    return await tileHandler(event);
  }

  return formatErrorResponse(404, "not found");
};
