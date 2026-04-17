'use client';

/**
 * External Call step editor — URL, method, headers, body template, auth,
 * response size limits.
 */

import { Plus, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { FieldHelp } from '@/components/ui/field-help';

import type { EditorProps } from './index';

export interface ExternalCallConfig extends Record<string, unknown> {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  bodyTemplate?: string;
  timeoutMs?: number;
  authType?: 'none' | 'bearer' | 'api-key' | 'query-param';
  authSecret?: string;
  authQueryParam?: string;
  maxResponseBytes?: number;
}

export function ExternalCallEditor({ config, onChange }: EditorProps<ExternalCallConfig>) {
  const headers = config.headers ?? {};
  const headerEntries = Object.entries(headers);

  const updateHeader = (oldKey: string, newKey: string, value: string): void => {
    const next = { ...headers };
    if (oldKey !== newKey) delete next[oldKey];
    next[newKey] = value;
    onChange({ headers: next });
  };

  const addHeader = (): void => {
    onChange({ headers: { ...headers, '': '' } });
  };

  const removeHeader = (key: string): void => {
    const next = { ...headers };
    delete next[key];
    onChange({ headers: next });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="ext-url" className="flex items-center text-xs">
          URL{' '}
          <FieldHelp title="Endpoint URL">
            The target HTTP endpoint. The host must be listed in the{' '}
            <code>ORCHESTRATION_ALLOWED_HOSTS</code> environment variable.
          </FieldHelp>
        </Label>
        <Input
          id="ext-url"
          value={config.url ?? ''}
          onChange={(e) => onChange({ url: e.target.value })}
          placeholder="https://api.example.com/v1/process"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="ext-method" className="text-xs">
            Method
          </Label>
          <select
            id="ext-method"
            value={config.method ?? 'POST'}
            onChange={(e) =>
              onChange({
                method: e.target.value as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
              })
            }
            className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
          >
            <option value="GET">GET</option>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="PATCH">PATCH</option>
            <option value="DELETE">DELETE</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ext-timeout" className="text-xs">
            Timeout (ms)
          </Label>
          <Input
            id="ext-timeout"
            type="number"
            value={config.timeoutMs ?? 30000}
            onChange={(e) => onChange({ timeoutMs: parseInt(e.target.value, 10) || 30000 })}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="ext-max-response" className="flex items-center text-xs">
          Max response size (bytes){' '}
          <FieldHelp title="Response size limit">
            Maximum response body size in bytes. Responses larger than this are rejected to prevent
            memory issues. Default: 1 MB (1048576 bytes).
          </FieldHelp>
        </Label>
        <Input
          id="ext-max-response"
          type="number"
          value={config.maxResponseBytes ?? 1048576}
          onChange={(e) => onChange({ maxResponseBytes: parseInt(e.target.value, 10) || 1048576 })}
        />
      </div>

      <div className="space-y-1.5">
        <Label className="flex items-center text-xs">
          Headers{' '}
          <FieldHelp title="Custom headers">
            Additional HTTP headers to send with the request. Content-Type is set to
            application/json by default for non-GET requests.
          </FieldHelp>
        </Label>
        <div className="space-y-2">
          {headerEntries.map(([key, value], index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                aria-label={`Header ${index + 1} name`}
                value={key}
                onChange={(e) => updateHeader(key, e.target.value, value)}
                placeholder="Header name"
                className="flex-1"
              />
              <Input
                aria-label={`Header ${index + 1} value`}
                value={value}
                onChange={(e) => updateHeader(key, key, e.target.value)}
                placeholder="Value"
                className="flex-1"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => removeHeader(key)}
                aria-label={`Remove header ${key || index + 1}`}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={addHeader} className="w-full">
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add header
          </Button>
        </div>
      </div>

      {config.method !== 'GET' && config.method !== 'DELETE' && (
        <div className="space-y-1.5">
          <Label htmlFor="ext-body" className="flex items-center text-xs">
            Body template{' '}
            <FieldHelp title="Body template">
              JSON body to send. Use <code>{'{{input}}'}</code> to interpolate the workflow input or{' '}
              <code>{'{{steps.stepId.output}}'}</code> for previous step outputs.
            </FieldHelp>
          </Label>
          <Textarea
            id="ext-body"
            value={config.bodyTemplate ?? ''}
            onChange={(e) => onChange({ bodyTemplate: e.target.value })}
            placeholder={'{\n  "data": "{{input}}"\n}'}
            rows={5}
            className="font-mono text-xs"
          />
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="ext-auth-type" className="text-xs">
            Auth type
          </Label>
          <select
            id="ext-auth-type"
            value={config.authType ?? 'none'}
            onChange={(e) =>
              onChange({
                authType: e.target.value as 'none' | 'bearer' | 'api-key' | 'query-param',
              })
            }
            className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
          >
            <option value="none">None</option>
            <option value="bearer">Bearer token</option>
            <option value="api-key">API key (header)</option>
            <option value="query-param">API key (query param)</option>
          </select>
        </div>
        {config.authType && config.authType !== 'none' && (
          <div className="space-y-1.5">
            <Label htmlFor="ext-auth-secret" className="flex items-center text-xs">
              Secret env var{' '}
              <FieldHelp title="Auth secret">
                Name of the environment variable holding the secret. Never enter the raw secret
                here.
              </FieldHelp>
            </Label>
            <Input
              id="ext-auth-secret"
              value={config.authSecret ?? ''}
              onChange={(e) => onChange({ authSecret: e.target.value })}
              placeholder="e.g. EXTERNAL_API_TOKEN"
              className="font-mono text-xs"
            />
          </div>
        )}
      </div>
      {config.authType === 'query-param' && (
        <div className="space-y-1.5">
          <Label htmlFor="ext-auth-query-param" className="flex items-center text-xs">
            Query parameter name{' '}
            <FieldHelp title="Query parameter">
              The name of the query parameter to attach the API key to. Defaults to{' '}
              <code>api_key</code> if left empty.
            </FieldHelp>
          </Label>
          <Input
            id="ext-auth-query-param"
            value={config.authQueryParam ?? ''}
            onChange={(e) => onChange({ authQueryParam: e.target.value })}
            placeholder="api_key"
            className="font-mono text-xs"
          />
        </div>
      )}
    </div>
  );
}
