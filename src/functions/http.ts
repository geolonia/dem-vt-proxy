import { formatErrorResponse, SimpleHandler } from "../libs/api-gateway";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import * as Accept from "@hapi/accept";
import fetch, { Headers } from "node-fetch";
import { encodeBuffer } from "http-encoding";
import { isEqual } from "lodash";
import { vector_tile } from "../libs/protobuf";
import tilebelt from '@mapbox/tilebelt';

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
            "ele": "Number, elevation from sea level in meters * 100.",
            "f_m": "Number, the F value of zfxy in meters."
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
  const relativePositions: TileRelativePosition[] = [];
  while (currentTile[2] > targetZoom) {
    const [
      rp1,
      newTile,
    ] = getPositionInParent(currentTile);
    relativePositions.unshift(rp1);
    currentTile = newTile;
  }
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
  const keys: string[] = [
    "ele",
    "f_height",
    "f_base",
    "x",
    "y",
    "z",
    "f",
  ];
  const values: vector_tile.Tile.IValue[] = [];
  const addValue = (value: vector_tile.Tile.IValue) => {
    let valIdx = values.findIndex((x) => isEqual(x, value));
    if (valIdx === -1) {
      valIdx = values.push(value) - 1;
    }
    return valIdx;
  }

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
  const demCubeZ = parentTile[2] + Math.log2(256);
  const zRes = (2**25) / (2**demCubeZ);

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
      const eleVal = Math.round(parseFloat(val) * 100);
      const fVal = Math.floor(parseFloat(val)/zRes);

      features.push({
        // id must be unique within the layer
        id: ((0xFF & rowIdx) << 8) | (0xFF & colIdx),
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
          0, // ele
          addValue({intValue: eleVal}),
          1, // f_height
          addValue({intValue: zRes * (fVal + 1)}),
          2, // f_base
          addValue({intValue: zRes * fVal}),
          3, // x
          addValue({intValue: (parentTile[0] * 2**(Math.log2(256))) + colIdx}),
          4, // y
          addValue({intValue: (parentTile[1] * 2**(Math.log2(256))) + rowIdx}),
          5, // z
          addValue({intValue: demCubeZ}),
          6, // f
          addValue({intValue: fVal})
        ],
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

function allPointsOnLine(x0: number, y0: number, x1: number, y1: number) {
  // Bresenham's line algorithm
  var dx = Math.abs(x1 - x0),
      dy = Math.abs(y1 - y0),
      sx = x0 < x1 ? 1 : -1,
      sy = y0 < y1 ? 1 : -1,
      err = dx - dy,
      out: [number, number][] = [];

  while (x0 != x1 || y0 != y1) {
    var e2 = 2 * err;
    if (e2 > (dy * -1)) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
    out.push([x0, y0]);
  }
  return out;
}

function getParentAtZ(tile: XYZTile, zoom: number) {
  const zDiff = tile[2] - zoom;
  if (zDiff < 0) throw new Error('negative zoom');
  return [
    tile[0] >> zDiff, tile[1] >> zDiff, tile[2] - zDiff
  ] as XYZTile;
}

const crossSectionHandler: SimpleHandler = async (event) => {
  const { z: zStr, from, to } = event.queryStringParameters;
  const z = parseInt(zStr, 10);
  const [x0, y0] = from.split(',').map(x => parseInt(x, 10));
  const [x1, y1] = to.split(',').map(x => parseInt(x, 10));

  const points = allPointsOnLine(x0, y0, x1, y1);
  // now we have all points on the line, we need to calculate what Z we need to request to GSI
  // to get the points
  // log2(256) = 8, so minus 8 from the requested Z should give us the Z level at which
  // one pixel equals one tile
  const requestZ = z - Math.log2(256);
  const requestingTiles = points
    .map(([x, y]) => getParentAtZ([x, y, z], requestZ).join('|'))
    .filter((v, i, s) => s.indexOf(v) === i)
    .map(x => x.split('|').map(x => parseInt(x, 10)) as unknown as XYZTile);

  const loadedTiles: { [key: string]: string[][] } = {};
  // todo: can be parallelized
  for (const tile of requestingTiles) {
    const demData = await getMergedDemData(tile[0], tile[1], tile[2]);
    if (!demData) {
      return formatErrorResponse(500, 'insufficient DEM data');
    }
    loadedTiles[`${tile[0]}/${tile[1]}`] = demData;
  }

  const annotatedPoints = [];

  const zRes = (2**25) / (2**z);

  for (const point of points) {
    const [x,y] = point;
    const [
      tile,
      [relX, relY],
    ] = getRelativePositionInAncestor([x, y, z], Math.log2(256));
    const tileData = loadedTiles[`${tile[0]}/${tile[1]}`];
    const demHeightStr = tileData[relY][relX];
    const demHeight = Math.round(parseFloat(demHeightStr) * 100);
    const fVal = Math.floor(parseFloat(demHeightStr)/zRes);
    annotatedPoints.push([...point, demHeight, fVal]);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      geojsonCubes: {
        type: "FeatureCollection",
        features: annotatedPoints.map(([x, y, height, fVal]) => ({
          type: "Feature",
          geometry: tilebelt.tileToGeoJSON([x, y, z]),
          properties: {
            ele: height,
            fh: zRes * (fVal + 1),
            fb: zRes * (fVal),
          }
        }))
      },
      annotatedPoints,
    }),
    headers: {
      'content-type': 'application/json',
    },
  };
}

export const main: APIGatewayProxyHandlerV2 = async (event) => {
  if (event.routeKey === 'GET /jgsi-dem/tiles.json') {
    return await metaHandler(event);
  } else if (event.routeKey === 'GET /jgsi-dem/tiles/{z}/{x}/{y}') {
    return await tileHandler(event);
  } else if (event.routeKey === 'GET /jgsi-dem/cross-section') {
    return await crossSectionHandler(event);
  }

  return formatErrorResponse(404, "not found");
};
