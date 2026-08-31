import { describe, expect, it } from 'vitest';
import {
  OneCliCapabilityError,
  compareVersions,
  detectPrivateDnsRouteCapability,
} from './onecli-capability.js';

describe('compareVersions', () => {
  it('orders dotted numeric versions', () => {
    expect(compareVersions('1.41.0', '1.41.0')).toBe(0);
    expect(compareVersions('1.41.0', '1.40.0')).toBeGreaterThan(0);
    expect(compareVersions('2.2.5', '2.2.4')).toBeGreaterThan(0);
    expect(compareVersions('1.41.0', '1.41.1')).toBeLessThan(0);
  });
});

describe('detectPrivateDnsRouteCapability', () => {
  it('detects the capability from pinned SDK and daemon versions', () => {
    expect(
      detectPrivateDnsRouteCapability({
        'onecli-gateway': '1.41.0',
        'onecli-cli': '2.2.5',
        'private-dns-route': '1',
      }),
    ).toBe(true);
  });

  it('fails closed when a version is missing', () => {
    expect(() =>
      detectPrivateDnsRouteCapability({ 'onecli-gateway': '', 'onecli-cli': '2.2.5', 'private-dns-route': '1' }),
    ).toThrow(OneCliCapabilityError);
  });

  it('fails closed when the daemon is below the minimum', () => {
    expect(() =>
      detectPrivateDnsRouteCapability({ 'onecli-gateway': '1.40.0', 'onecli-cli': '2.2.5', 'private-dns-route': '1' }),
    ).toThrow(OneCliCapabilityError);
  });

  it('fails closed when the SDK is below the minimum', () => {
    expect(() =>
      detectPrivateDnsRouteCapability({ 'onecli-gateway': '1.41.0', 'onecli-cli': '2.2.4', 'private-dns-route': '1' }),
    ).toThrow(OneCliCapabilityError);
  });

  it('fails closed when the capability version is missing or mismatched', () => {
    expect(() =>
      detectPrivateDnsRouteCapability({ 'onecli-gateway': '1.41.0', 'onecli-cli': '2.2.5' }),
    ).toThrow(OneCliCapabilityError);
    expect(() =>
      detectPrivateDnsRouteCapability({ 'onecli-gateway': '1.41.0', 'onecli-cli': '2.2.5', 'private-dns-route': '2' }),
    ).toThrow(OneCliCapabilityError);
  });
});
