/**
 * Comprehensive list of IANA timezones
 *
 * Organized by region with human-readable labels.
 * Uses standard IANA timezone identifiers.
 */

export interface TimezoneOption {
  value: string;
  label: string;
  region: string;
}

export const TIMEZONES: TimezoneOption[] = [
  // UTC
  { value: 'UTC', label: 'UTC (Coordinated Universal Time)', region: 'UTC' },

  // Africa
  { value: 'Africa/Abidjan', label: 'Abidjan', region: 'Africa' },
  { value: 'Africa/Accra', label: 'Accra', region: 'Africa' },
  { value: 'Africa/Addis_Ababa', label: 'Addis Ababa', region: 'Africa' },
  { value: 'Africa/Algiers', label: 'Algiers', region: 'Africa' },
  { value: 'Africa/Cairo', label: 'Cairo', region: 'Africa' },
  { value: 'Africa/Casablanca', label: 'Casablanca', region: 'Africa' },
  { value: 'Africa/Dar_es_Salaam', label: 'Dar es Salaam', region: 'Africa' },
  { value: 'Africa/Johannesburg', label: 'Johannesburg', region: 'Africa' },
  { value: 'Africa/Khartoum', label: 'Khartoum', region: 'Africa' },
  { value: 'Africa/Lagos', label: 'Lagos', region: 'Africa' },
  { value: 'Africa/Nairobi', label: 'Nairobi', region: 'Africa' },
  { value: 'Africa/Tunis', label: 'Tunis', region: 'Africa' },

  // America - North
  { value: 'America/Anchorage', label: 'Anchorage', region: 'America' },
  { value: 'America/Chicago', label: 'Chicago (Central Time)', region: 'America' },
  { value: 'America/Denver', label: 'Denver (Mountain Time)', region: 'America' },
  { value: 'America/Detroit', label: 'Detroit', region: 'America' },
  { value: 'America/Edmonton', label: 'Edmonton', region: 'America' },
  { value: 'America/Halifax', label: 'Halifax (Atlantic Time)', region: 'America' },
  { value: 'America/Honolulu', label: 'Honolulu (Hawaii)', region: 'America' },
  { value: 'America/Los_Angeles', label: 'Los Angeles (Pacific Time)', region: 'America' },
  { value: 'America/New_York', label: 'New York (Eastern Time)', region: 'America' },
  { value: 'America/Phoenix', label: 'Phoenix (Arizona)', region: 'America' },
  { value: 'America/St_Johns', label: "St. John's (Newfoundland)", region: 'America' },
  { value: 'America/Toronto', label: 'Toronto', region: 'America' },
  { value: 'America/Vancouver', label: 'Vancouver', region: 'America' },
  { value: 'America/Winnipeg', label: 'Winnipeg', region: 'America' },

  // America - Central & South
  { value: 'America/Argentina/Buenos_Aires', label: 'Buenos Aires', region: 'America' },
  { value: 'America/Bogota', label: 'Bogotá', region: 'America' },
  { value: 'America/Caracas', label: 'Caracas', region: 'America' },
  { value: 'America/Costa_Rica', label: 'Costa Rica', region: 'America' },
  { value: 'America/Guatemala', label: 'Guatemala', region: 'America' },
  { value: 'America/Havana', label: 'Havana', region: 'America' },
  { value: 'America/Jamaica', label: 'Jamaica', region: 'America' },
  { value: 'America/Lima', label: 'Lima', region: 'America' },
  { value: 'America/Mexico_City', label: 'Mexico City', region: 'America' },
  { value: 'America/Panama', label: 'Panama', region: 'America' },
  { value: 'America/Santiago', label: 'Santiago', region: 'America' },
  { value: 'America/Sao_Paulo', label: 'São Paulo', region: 'America' },

  // Asia
  { value: 'Asia/Almaty', label: 'Almaty', region: 'Asia' },
  { value: 'Asia/Baghdad', label: 'Baghdad', region: 'Asia' },
  { value: 'Asia/Baku', label: 'Baku', region: 'Asia' },
  { value: 'Asia/Bangkok', label: 'Bangkok', region: 'Asia' },
  { value: 'Asia/Beirut', label: 'Beirut', region: 'Asia' },
  { value: 'Asia/Colombo', label: 'Colombo', region: 'Asia' },
  { value: 'Asia/Dhaka', label: 'Dhaka', region: 'Asia' },
  { value: 'Asia/Dubai', label: 'Dubai', region: 'Asia' },
  { value: 'Asia/Ho_Chi_Minh', label: 'Ho Chi Minh City', region: 'Asia' },
  { value: 'Asia/Hong_Kong', label: 'Hong Kong', region: 'Asia' },
  { value: 'Asia/Istanbul', label: 'Istanbul', region: 'Asia' },
  { value: 'Asia/Jakarta', label: 'Jakarta', region: 'Asia' },
  { value: 'Asia/Jerusalem', label: 'Jerusalem', region: 'Asia' },
  { value: 'Asia/Kabul', label: 'Kabul', region: 'Asia' },
  { value: 'Asia/Karachi', label: 'Karachi', region: 'Asia' },
  { value: 'Asia/Kathmandu', label: 'Kathmandu', region: 'Asia' },
  { value: 'Asia/Kolkata', label: 'Kolkata (India)', region: 'Asia' },
  { value: 'Asia/Kuala_Lumpur', label: 'Kuala Lumpur', region: 'Asia' },
  { value: 'Asia/Kuwait', label: 'Kuwait', region: 'Asia' },
  { value: 'Asia/Manila', label: 'Manila', region: 'Asia' },
  { value: 'Asia/Muscat', label: 'Muscat', region: 'Asia' },
  { value: 'Asia/Riyadh', label: 'Riyadh', region: 'Asia' },
  { value: 'Asia/Seoul', label: 'Seoul', region: 'Asia' },
  { value: 'Asia/Shanghai', label: 'Shanghai', region: 'Asia' },
  { value: 'Asia/Singapore', label: 'Singapore', region: 'Asia' },
  { value: 'Asia/Taipei', label: 'Taipei', region: 'Asia' },
  { value: 'Asia/Tehran', label: 'Tehran', region: 'Asia' },
  { value: 'Asia/Tokyo', label: 'Tokyo', region: 'Asia' },
  { value: 'Asia/Yangon', label: 'Yangon', region: 'Asia' },

  // Atlantic
  { value: 'Atlantic/Azores', label: 'Azores', region: 'Atlantic' },
  { value: 'Atlantic/Canary', label: 'Canary Islands', region: 'Atlantic' },
  { value: 'Atlantic/Cape_Verde', label: 'Cape Verde', region: 'Atlantic' },
  { value: 'Atlantic/Reykjavik', label: 'Reykjavik', region: 'Atlantic' },

  // Australia
  { value: 'Australia/Adelaide', label: 'Adelaide', region: 'Australia' },
  { value: 'Australia/Brisbane', label: 'Brisbane', region: 'Australia' },
  { value: 'Australia/Darwin', label: 'Darwin', region: 'Australia' },
  { value: 'Australia/Hobart', label: 'Hobart', region: 'Australia' },
  { value: 'Australia/Melbourne', label: 'Melbourne', region: 'Australia' },
  { value: 'Australia/Perth', label: 'Perth', region: 'Australia' },
  { value: 'Australia/Sydney', label: 'Sydney', region: 'Australia' },

  // Europe
  { value: 'Europe/Amsterdam', label: 'Amsterdam', region: 'Europe' },
  { value: 'Europe/Athens', label: 'Athens', region: 'Europe' },
  { value: 'Europe/Belgrade', label: 'Belgrade', region: 'Europe' },
  { value: 'Europe/Berlin', label: 'Berlin', region: 'Europe' },
  { value: 'Europe/Brussels', label: 'Brussels', region: 'Europe' },
  { value: 'Europe/Bucharest', label: 'Bucharest', region: 'Europe' },
  { value: 'Europe/Budapest', label: 'Budapest', region: 'Europe' },
  { value: 'Europe/Copenhagen', label: 'Copenhagen', region: 'Europe' },
  { value: 'Europe/Dublin', label: 'Dublin', region: 'Europe' },
  { value: 'Europe/Helsinki', label: 'Helsinki', region: 'Europe' },
  { value: 'Europe/Kyiv', label: 'Kyiv', region: 'Europe' },
  { value: 'Europe/Lisbon', label: 'Lisbon', region: 'Europe' },
  { value: 'Europe/London', label: 'London', region: 'Europe' },
  { value: 'Europe/Madrid', label: 'Madrid', region: 'Europe' },
  { value: 'Europe/Milan', label: 'Milan', region: 'Europe' },
  { value: 'Europe/Moscow', label: 'Moscow', region: 'Europe' },
  { value: 'Europe/Oslo', label: 'Oslo', region: 'Europe' },
  { value: 'Europe/Paris', label: 'Paris', region: 'Europe' },
  { value: 'Europe/Prague', label: 'Prague', region: 'Europe' },
  { value: 'Europe/Rome', label: 'Rome', region: 'Europe' },
  { value: 'Europe/Sofia', label: 'Sofia', region: 'Europe' },
  { value: 'Europe/Stockholm', label: 'Stockholm', region: 'Europe' },
  { value: 'Europe/Vienna', label: 'Vienna', region: 'Europe' },
  { value: 'Europe/Warsaw', label: 'Warsaw', region: 'Europe' },
  { value: 'Europe/Zurich', label: 'Zurich', region: 'Europe' },

  // Indian Ocean
  { value: 'Indian/Maldives', label: 'Maldives', region: 'Indian' },
  { value: 'Indian/Mauritius', label: 'Mauritius', region: 'Indian' },

  // Pacific
  { value: 'Pacific/Auckland', label: 'Auckland', region: 'Pacific' },
  { value: 'Pacific/Fiji', label: 'Fiji', region: 'Pacific' },
  { value: 'Pacific/Guam', label: 'Guam', region: 'Pacific' },
  { value: 'Pacific/Honolulu', label: 'Honolulu', region: 'Pacific' },
  { value: 'Pacific/Noumea', label: 'Noumea', region: 'Pacific' },
  { value: 'Pacific/Pago_Pago', label: 'Pago Pago', region: 'Pacific' },
  { value: 'Pacific/Port_Moresby', label: 'Port Moresby', region: 'Pacific' },
  { value: 'Pacific/Tahiti', label: 'Tahiti', region: 'Pacific' },
  { value: 'Pacific/Tongatapu', label: 'Tongatapu', region: 'Pacific' },
];

/**
 * Get timezones grouped by region
 */
export function getTimezonesByRegion(): Record<string, TimezoneOption[]> {
  return TIMEZONES.reduce<Record<string, TimezoneOption[]>>((acc, tz) => {
    if (!acc[tz.region]) {
      acc[tz.region] = [];
    }
    acc[tz.region].push(tz);
    return acc;
  }, {});
}

/**
 * Get unique regions in display order
 */
export function getTimezoneRegions(): string[] {
  return [
    'UTC',
    'Africa',
    'America',
    'Asia',
    'Atlantic',
    'Australia',
    'Europe',
    'Indian',
    'Pacific',
  ];
}

/**
 * Find a timezone by its IANA identifier
 */
export function findTimezone(value: string): TimezoneOption | undefined {
  return TIMEZONES.find((tz) => tz.value === value);
}
