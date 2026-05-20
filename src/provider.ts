import { DPProviderDescriptor } from './types';

export const mssqlProvider: DPProviderDescriptor = {
  providerId: 'mssql',
  displayName: 'Microsoft SQL Server',
  dialect: 'mssql',
  formSchema: {
    fields: [
      {
        key: 'host',
        label: 'Host',
        type: 'text',
        tab: 'connection',
        storage: 'profile',
        required: true,
        defaultValue: 'localhost',
        width: 'half'
      },
      {
        key: 'port',
        label: 'Port',
        type: 'number',
        tab: 'connection',
        storage: 'profile',
        required: true,
        defaultValue: 1433,
        min: 1,
        max: 65535,
        width: 'half'
      },
      {
        key: 'database',
        label: 'Database',
        type: 'text',
        tab: 'connection',
        storage: 'profile',
        required: true,
        placeholder: 'master',
        width: 'half'
      },
      {
        key: 'schema',
        label: 'Default Schema (Optional)',
        type: 'text',
        tab: 'connection',
        storage: 'profile',
        placeholder: 'dbo',
        description: 'Used as the default schema hint. Introspection returns all visible user schemas in the selected database.',
        width: 'half'
      },
      {
        key: 'ssl',
        label: 'Encrypt Connection',
        type: 'checkbox',
        tab: 'connection',
        storage: 'profile',
        defaultValue: false,
        width: 'full'
      },
      {
        key: 'sslMode',
        label: 'Certificate Validation',
        type: 'select',
        tab: 'connection',
        storage: 'profile',
        defaultValue: 'trust-server-certificate',
        options: [
          { value: 'trust-server-certificate', label: 'Trust Server Certificate' },
          { value: 'validate-certificate', label: 'Validate Certificate' }
        ],
        visibleWhen: {
          storage: 'profile',
          key: 'ssl',
          truthy: true
        },
        width: 'full'
      },
      {
        key: 'authMode',
        label: 'Authentication Mode',
        type: 'select',
        tab: 'auth',
        storage: 'profile',
        defaultValue: 'password',
        options: [
          { value: 'password', label: 'SQL Login / Password' }
        ],
        width: 'full'
      },
      {
        key: 'username',
        label: 'Username',
        type: 'text',
        tab: 'auth',
        storage: 'profile',
        required: true,
        width: 'full'
      },
      {
        key: 'password',
        label: 'Password',
        type: 'password',
        tab: 'auth',
        storage: 'secrets',
        required: true,
        width: 'full'
      }
    ]
  },
  supports: {
    ssl: true,
    oauth: false,
    keypair: false,
    introspection: true,
    cancellation: true
  }
};
