import type { API } from 'homebridge';

import { PLATFORM_NAME, SpanMatterPlatform } from './platform.js';

export default (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, SpanMatterPlatform);
};
