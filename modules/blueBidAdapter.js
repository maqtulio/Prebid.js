import { deepAccess, deepSetValue, logError } from '../src/utils.js';
import { registerBidder } from '../src/adapters/bidderFactory.js';
import { BANNER } from '../src/mediaTypes.js';
import { getStorageManager } from '../src/storageManager.js';
import { ortbConverter } from '../libraries/ortbConverter/converter.js';
import { ortb25Translator } from '../libraries/ortb2.5Translator/translator.js';

/**
 * @typedef {import('../src/adapters/bidderFactory.js').BidRequest} BidRequest
 * @typedef {import('../src/adapters/bidderFactory.js').Bid} Bid
 * @typedef {import('../src/adapters/bidderFactory.js').ServerRequest} ServerRequest
 * @typedef {import('../src/adapters/bidderFactory.js').BidderSpec} BidderSpec
 * @typedef {import('../src/adapters/bidderFactory.js').TimedOutBid} TimedOutBid
 */

const BIDDER_CODE = 'blue';
const GVLID = 620;
const CDB_ENDPOINT = 'https://bidder-us-east-1.getblue.io/engine/?src=prebid';
const BUNDLE_COOKIE_NAME = 'ckid';

export const storage = getStorageManager({ bidderCode: BIDDER_CODE });
const TRANSLATOR = ortb25Translator();

/**
 * Defines the generic oRTB converter and all customization functions.
 */
const CONVERTER = ortbConverter({
  context: {
    netRevenue: true,
    ttl: 60,
  },
  imp,
  request,
  bidResponse,
  response,
});

/**
 * Builds an impression object for the ORTB 2.5 request.
 *
 * @param {function} buildImp - The function for building an imp object.
 * @param {Object} bidRequest - The bid request object.
 * @param {Object} context - The context object.
 * @returns {Object} The ORTB 2.5 imp object.
 */
function imp(buildImp, bidRequest, context) {
  let imp = buildImp(bidRequest, context);
  const params = bidRequest.params;

  imp.tagid = bidRequest.adUnitCode;
  deepSetValue(imp, 'ext', {
    ...bidRequest.params.ext,
    ...imp.ext,
    rwdd: imp.rwdd,
    floors: getFloors(bidRequest),
    bidder: {
      publishersubid: params?.publisherSubId,
      zoneid: params?.zoneId,
      uid: params?.uid,
    },
  });

  delete imp.rwdd; // oRTB 2.6 field moved to ext

  return imp;
}

/**
 * Builds a request object for the ORTB 2.5 request.
 *
 * @param {function} buildRequest - The function for building a request object.
 * @param {Array} imps - An array of ORTB 2.5 impression objects.
 * @param {Object} bidderRequest - The bidder request object.
 * @param {Object} context - The context object.
 * @returns {Object} The ORTB 2.5 request object.
 */
function request(buildRequest, imps, bidderRequest, context) {
  let request = buildRequest(imps, bidderRequest, context);

  // params.pubid should override publisher id
  if (typeof context.publisherId !== 'undefined') {
    if (typeof request.app !== 'undefined') {
      deepSetValue(request, 'app.publisher.id', context.publisherId);
    } else {
      deepSetValue(request, 'site.publisher.id', context.publisherId);
    }
  }

  if (bidderRequest && bidderRequest.gdprConsent) {
    deepSetValue(
      request,
      'regs.ext.gdprversion',
      bidderRequest.gdprConsent.apiVersion
    );
  }

  // Translate 2.6 OpenRTB request into 2.5 OpenRTB request
  request = TRANSLATOR(request);

  return request;
}

/**
 * Build bid from oRTB 2.5 bid.
 *
 * @param buildBidResponse
 * @param bid
 * @param context
 * @returns {*}
 */
function bidResponse(buildBidResponse, bid, context) {
  context.mediaType = deepAccess(bid, 'ext.mediatype');
  let bidResponse = buildBidResponse(bid, context);

  bidResponse.currency = deepAccess(bid, 'ext.cur');

  if (typeof deepAccess(bid, 'ext.meta') !== 'undefined') {
    deepSetValue(bidResponse, 'meta', {
      ...bidResponse.meta,
      ...bid.ext.meta,
    });
  }
  if (typeof deepAccess(bid, 'ext.paf.content_id') !== 'undefined') {
    deepSetValue(bidResponse, 'meta.paf.content_id', bid.ext.paf.content_id);
  }

  return bidResponse;
}

/**
 * Builds bid response from the oRTB 2.5 bid response.
 *
 * @param buildResponse
 * @param bidResponses
 * @param ortbResponse
 * @param context
 * @returns *
 */
function response(buildResponse, bidResponses, ortbResponse, context) {
  let response = buildResponse(bidResponses, ortbResponse, context);

  const pafTransmission = deepAccess(ortbResponse, 'ext.paf.transmission');
  response.bids.forEach((bid) => {
    if (
      typeof pafTransmission !== 'undefined' &&
      typeof deepAccess(bid, 'meta.paf.content_id') !== 'undefined'
    ) {
      deepSetValue(bid, 'meta.paf.transmission', pafTransmission);
    } else {
      delete bid.meta.paf;
    }
  });

  return response;
}

/** @type {BidderSpec} */
export const spec = {
  code: BIDDER_CODE,
  gvlid: GVLID,
  supportedMediaTypes: [BANNER],

  /**
   * Validates the bid request.
   * @param {object} bid
   * @return {boolean}
   */
  isBidRequestValid: (bid) => isValidBidRequest(bid),

  /**
   * Builds requests for the bidder.
   * @param {BidRequest[]} bidRequests
   * @param {*} bidderRequest
   * @return {ServerRequest}
   */
  buildRequests: (bidRequests, bidderRequest) => {
    const context = buildContext(bidRequests, bidderRequest);
    const url = buildUrl(context.publisherId);
    const data = prepareData(bidRequests, bidderRequest, context);

    if (data) {
      return { method: 'POST', url, data, bidRequests };
    }
  },

  /**
   * Interprets the server response.
   * @param {*} response
   * @param {ServerRequest} request
   * @return {Bid[] | {bids: Bid[], fledgeAuctionConfigs: object[]}}
   */
  interpretResponse: (response, request) => interpretServerResponse(response, request),
};

// Helper functions

/**
 * Validates a bid request.
 * @param {object} bid
 * @return {boolean}
 */
function isValidBidRequest(bid) {
  return bid?.params?.publisherId ? true : false;
}

/**
 * Builds the request context.
 * @param {BidRequest[]} bidRequests
 * @param {*} bidderRequest
 * @return {object}
 */
function buildContext(bidRequests, bidderRequest) {
  const publisherId = bidRequests.find((bidRequest) => bidRequest.params?.pubid)?.params.pubid;
  return {
    url: bidderRequest?.refererInfo?.page || '',
    publisherId,
  };
}

/**
 * Builds the request URL.
 * @param {string} publisherId
 * @return {string}
 */
function buildUrl(publisherId) {
  let url = CDB_ENDPOINT;
  url += '&wv=' + encodeURIComponent('$prebid.version$');
  url += '&cb=' + String(Math.floor(Math.random() * 99999999999));

  if (publisherId) {
    url += `&publisherId=` + publisherId;
  }

  return url;
}

/**
 * Prepares the request data.
 * @param {BidRequest[]} bidRequests
 * @param {*} bidderRequest
 * @param {object} context
 * @return {object}
 */
function prepareData(bidRequests, bidderRequest, context) {
  const data = CONVERTER.toORTB({ bidderRequest, bidRequests, context });

  if (!data.user) {
    data.user = {};
  }

  if (!data.user.ext) {
    data.user.ext = {
      buyerid: storage.cookiesAreEnabled() ? storage.getCookie(BUNDLE_COOKIE_NAME) : undefined,
    };
  }

  return data;
}

/**
 * Interprets the server response.
 * @param {*} response
 * @param {ServerRequest} request
 * @return {Bid[] | {bids: Bid[], fledgeAuctionConfigs: object[]}}
 */
function interpretServerResponse(response, request) {
  if (!response?.body) {
    return []; // No bids
  }

  const interpretedResponse = CONVERTER.fromORTB({
    response: response.body,
    request: request.data,
  });

  return interpretedResponse.bids || [];
}

function getFloors(bidRequest) {
  try {
    const floors = {};

    const parseBidFloor = () => {
      if (bidRequest.params?.bidFloor && bidRequest.params?.bidFloorCur) {
        try {
          const floor = parseFloat(bidRequest.params.bidFloor);
          return {
            currency: bidRequest.params.bidFloorCur,
            floor: floor,
          };
        } catch {
          return undefined;
        }
      }
      return undefined;
    };

    const calculateBannerFloors = (getFloor) => {
      const sizes = deepAccess(bidRequest, 'mediaTypes.banner.sizes');
      if (!sizes) return [];

      const normalizeSizes = (sizes) =>
        Array.isArray(sizes[0]) ? sizes : [sizes]; // Normalize to array of sizes
      const bannerSizes = normalizeSizes(sizes);

      return bannerSizes.reduce((bannerFloors, bannerSize) => {
        const sizeKey = `${bannerSize[0]}x${bannerSize[1]}`;
        bannerFloors[sizeKey] = getFloor.call(bidRequest, {
          size: bannerSize,
          mediaType: BANNER,
        });
        return bannerFloors;
      }, {});
    };

    let getFloor = bidRequest.getFloor || parseBidFloor();

    if (getFloor && bidRequest.mediaTypes?.banner) {
      floors.banner = calculateBannerFloors(getFloor);
    }

    return floors;
  } catch (e) {
    logError('Could not parse floors from Prebid: ' + e);
    return {};
  }
}

registerBidder(spec);
