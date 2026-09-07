import * as sql from 'mssql';
import * as net from 'net';
import {
  ColumnModel,
  ConnectionProfile,
  ConnectionSecrets,
  DbAdapter,
  ForeignKeyModel,
  IndexModel,
  NonQueryResult,
  QueryColumn,
  QueryResult,
  QueryRunOptions,
  RoutineKind,
  RoutineModel,
  RoutineParameterModel,
  SchemaIntrospection,
  SshTunnelResult,
  TableModel
} from './types';

interface MssqlSchemaEntry {
  name: string;
  tables: Map<string, TableModel>;
  views: Map<string, TableModel>;
  procedures: RoutineModel[];
  functions: RoutineModel[];
}

interface IndexAccumulator {
  name: string;
  unique: boolean;
  columns: string[];
}

const CONNECTION_TIMEOUT_MS = 30000;
const REQUEST_TIMEOUT_MS = 30000;

type OpenSshTunnelFn = (profile: ConnectionProfile, secrets: ConnectionSecrets) => Promise<SshTunnelResult>;

export class MssqlAdapter implements DbAdapter {
  readonly dialect = 'mssql';
  private readonly _openSshTunnel?: OpenSshTunnelFn;

  constructor(openSshTunnel?: OpenSshTunnelFn) {
    this._openSshTunnel = openSshTunnel;
  }

  async testConnection(profile: ConnectionProfile, secrets: ConnectionSecrets): Promise<void> {
    await this.withPool(profile, secrets, async (pool) => {
      await pool.request().query('SELECT 1 AS ok');
    });
  }

  async runQuery(
    profile: ConnectionProfile,
    secrets: ConnectionSecrets,
    sqlText: string,
    _options: QueryRunOptions
  ): Promise<QueryResult> {
    return this.withPool(profile, secrets, async (pool) => {
      const start = Date.now();
      const result = await pool.request().query(sqlText);
      const elapsedMs = Date.now() - start;

      const recordset = result.recordset as sql.IRecordSet<Record<string, unknown>> | undefined;
      const rows = (recordset ?? []).map((row) => toJsonSafe(row)) as Record<string, unknown>[];
      const columns = this.extractColumns(recordset, rows);

      return {
        columns,
        rows,
        rowCount: rows.length,
        elapsedMs
      };
    });
  }

  async executeNonQuery(
    profile: ConnectionProfile,
    secrets: ConnectionSecrets,
    sqlText: string
  ): Promise<NonQueryResult> {
    return this.withPool(profile, secrets, async (pool) => {
      const result = await pool.request().query(sqlText);
      const affectedRows = Array.isArray(result.rowsAffected)
        ? result.rowsAffected.reduce((sum, count) => sum + count, 0)
        : null;
      return { affectedRows };
    });
  }

  async introspectSchema(
    profile: ConnectionProfile,
    secrets: ConnectionSecrets
  ): Promise<SchemaIntrospection> {
    return this.withPool(profile, secrets, async (pool) => {
      const schemasMap = new Map<string, MssqlSchemaEntry>();

      const [schemaRows, columnRows, primaryKeyRows, foreignKeyRows, indexRows, routineRows] = await Promise.all([
        this.querySchemas(pool),
        this.queryColumns(pool, profile),
        this.queryPrimaryKeys(pool, profile),
        this.queryForeignKeys(pool, profile),
        this.queryIndexes(pool, profile),
        this.queryRoutines(pool, profile)
      ]);

      for (const row of schemaRows) {
        const schemaName = getString(row, 'schema_name');
        if (schemaName) {
          this.ensureSchema(schemasMap, schemaName);
        }
      }

      for (const row of columnRows) {
        const schemaName = getString(row, 'schema_name');
        const objectName = getString(row, 'object_name');
        const objectType = getString(row, 'object_type');
        const columnName = getString(row, 'column_name');
        if (!schemaName || !objectName || !columnName) continue;

        const schema = this.ensureSchema(schemasMap, schemaName);
        const targetMap = objectType === 'V' ? schema.views : schema.tables;
        if (!targetMap.has(objectName)) {
          targetMap.set(objectName, {
            name: objectName,
            comment: getString(row, 'table_comment'),
            columns: [],
            primaryKey: [],
            foreignKeys: []
          });
        }

        const table = targetMap.get(objectName);
        if (!table) continue;

        table.columns.push({
          name: columnName,
          type: this.formatType(row),
          nullable: getBool(row, 'is_nullable'),
          comment: getString(row, 'column_comment')
        });
      }

      for (const row of primaryKeyRows) {
        const schemaName = getString(row, 'schema_name');
        const tableName = getString(row, 'table_name');
        const columnName = getString(row, 'column_name');
        if (!schemaName || !tableName || !columnName) continue;

        const table = schemasMap.get(schemaName)?.tables.get(tableName);
        if (!table) continue;
        table.primaryKey = table.primaryKey ?? [];
        table.primaryKey.push(columnName);
      }

      for (const row of foreignKeyRows) {
        const schemaName = getString(row, 'schema_name');
        const tableName = getString(row, 'table_name');
        const columnName = getString(row, 'column_name');
        const foreignSchema = getString(row, 'foreign_schema');
        const foreignTable = getString(row, 'foreign_table');
        const foreignColumn = getString(row, 'foreign_column');
        if (!schemaName || !tableName || !columnName || !foreignSchema || !foreignTable || !foreignColumn) continue;

        const table = schemasMap.get(schemaName)?.tables.get(tableName);
        if (!table) continue;

        const foreignKey: ForeignKeyModel = {
          name: getString(row, 'constraint_name'),
          column: columnName,
          foreignSchema,
          foreignTable,
          foreignColumn
        };
        table.foreignKeys = table.foreignKeys ?? [];
        table.foreignKeys.push(foreignKey);
      }

      const indexesByTable = new Map<string, { schemaName: string; tableName: string; index: IndexAccumulator }>();
      for (const row of indexRows) {
        const schemaName = getString(row, 'schema_name');
        const tableName = getString(row, 'table_name');
        const indexName = getString(row, 'index_name');
        const columnName = getString(row, 'column_name');
        if (!schemaName || !tableName || !indexName || !columnName) continue;

        const key = `${schemaName}.${tableName}.${indexName}`;
        if (!indexesByTable.has(key)) {
          indexesByTable.set(key, {
            schemaName,
            tableName,
            index: {
              name: indexName,
              unique: getBool(row, 'is_unique'),
              columns: []
            }
          });
        }
        indexesByTable.get(key)?.index.columns.push(columnName);
      }

      for (const { schemaName, tableName, index } of indexesByTable.values()) {
        const table = schemasMap.get(schemaName)?.tables.get(tableName);
        if (!table) continue;
        table.indexes = table.indexes ?? [];
        table.indexes.push(index as IndexModel);
      }

      const routinesByKey = new Map<string, RoutineModel>();
      for (const row of routineRows) {
        const schemaName = getString(row, 'schema_name');
        const routineName = getString(row, 'routine_name');
        const routineType = getString(row, 'routine_type');
        if (!schemaName || !routineName || !routineType) continue;

        const routineKey = `${schemaName}.${routineName}.${routineType}`;
        let routine = routinesByKey.get(routineKey);
        if (!routine) {
          const kind: RoutineKind = routineType === 'P' || routineType === 'PC' ? 'procedure' : 'function';
          routine = {
            name: routineName,
            kind,
            comment: getString(row, 'routine_comment'),
            schemaQualifiedName: `${schemaName}.${routineName}`,
            parameters: []
          };
          routinesByKey.set(routineKey, routine);

          const schema = this.ensureSchema(schemasMap, schemaName);
          if (kind === 'procedure') {
            schema.procedures.push(routine);
          } else {
            schema.functions.push(routine);
          }
        }

        const parameterId = getNumber(row, 'parameter_id');
        const parameterName = getString(row, 'parameter_name');
        const parameterType = this.formatType(row);
        if (parameterId === undefined) continue;

        if (parameterId === 0) {
          routine.returnType = parameterType;
          continue;
        }

        const parameter: RoutineParameterModel = {
          name: parameterName || `param${parameterId}`,
          mode: getBool(row, 'is_output') ? 'out' : 'in',
          type: parameterType,
          position: parameterId
        };
        routine.parameters = routine.parameters ?? [];
        routine.parameters.push(parameter);
      }

      for (const schema of schemasMap.values()) {
        for (const routine of [...schema.procedures, ...schema.functions]) {
          routine.parameters = (routine.parameters ?? []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
          routine.signature = this.buildRoutineSignature(routine);
        }
        schema.procedures.sort((a, b) => a.name.localeCompare(b.name));
        schema.functions.sort((a, b) => a.name.localeCompare(b.name));
      }

      const schemas = Array.from(schemasMap.values())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((schema) => ({
          name: schema.name,
          tables: Array.from(schema.tables.values()).sort((a, b) => a.name.localeCompare(b.name)),
          views: Array.from(schema.views.values()).sort((a, b) => a.name.localeCompare(b.name)),
          procedures: schema.procedures,
          functions: schema.functions
        }));

      return {
        version: '0.2',
        generatedAt: new Date().toISOString(),
        connectionId: profile.id,
        connectionName: profile.name,
        dialect: 'mssql',
        schemas
      };
    });
  }

  // ─── Optional table-operation capabilities ────────────────────────────────
  // MSSQL has no built-in `GET_DDL` and `SELECT ... INTO` copies do not
  // preserve PKs/defaults/indexes — for those operations Core's fallback SQL
  // is not worse than what this adapter could emit without scripting from
  // sys.tables/sys.columns/sys.default_constraints. TRUNCATE is a thin native
  // primitive worth exposing so the capability probe pattern is exercised and
  // the adapter can be extended in the future without touching Core.

  async truncateTable(
    profile: ConnectionProfile,
    secrets: ConnectionSecrets,
    schema: string | undefined,
    table: string
  ): Promise<void> {
    await this.withPool(profile, secrets, async (pool) => {
      const fqn = this.quoteQualified(schema, table);
      await pool.request().query(`TRUNCATE TABLE ${fqn}`);
    });
  }

  private quoteQualified(schema: string | undefined, table: string): string {
    const quote = (n: string) => `[${n.replace(/]/g, ']]')}]`;
    return schema ? `${quote(schema)}.${quote(table)}` : quote(table);
  }

  private async withPool<T>(
    profile: ConnectionProfile,
    secrets: ConnectionSecrets,
    callback: (pool: sql.ConnectionPool) => Promise<T>
  ): Promise<T> {
    let tunnel: SshTunnelResult | undefined;
    const config = this.createConfig(profile, secrets);

    if (profile.sshEnabled && this._openSshTunnel) {
      tunnel = await this._openSshTunnel(profile, secrets);
      config.options = {
        ...config.options,
        connector: () => Promise.resolve(tunnel!.stream as unknown as net.Socket),
      };
    }

    const pool = new sql.ConnectionPool(config);
    try {
      await pool.connect();
      return await callback(pool);
    } finally {
      await pool.close();
      tunnel?.close();
    }
  }

  private createConfig(profile: ConnectionProfile, secrets: ConnectionSecrets): sql.config {
    return {
      server: profile.host || 'localhost',
      port: typeof profile.port === 'number' ? profile.port : 1433,
      database: profile.database || 'master',
      user: profile.username,
      password: String(secrets.password ?? ''),
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
      options: {
        encrypt: profile.ssl === true,
        trustServerCertificate: profile.sslMode !== 'validate-certificate',
        enableArithAbort: true
      }
    };
  }

  private querySchemas(pool: sql.ConnectionPool): Promise<Array<Record<string, unknown>>> {
    return pool.request().query(`
      SELECT s.name AS schema_name
      FROM sys.schemas s
      WHERE s.name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest')
      ORDER BY s.name
    `).then((result) => result.recordset as Array<Record<string, unknown>>);
  }

  private queryColumns(pool: sql.ConnectionPool, _profile: ConnectionProfile): Promise<Array<Record<string, unknown>>> {
    return pool.request().query(`
      SELECT
        s.name AS schema_name,
        o.name AS object_name,
        o.type AS object_type,
        CAST(table_prop.value AS nvarchar(max)) AS table_comment,
        c.name AS column_name,
        TYPE_NAME(c.user_type_id) AS data_type,
        c.max_length,
        c.precision,
        c.scale,
        c.is_nullable,
        CAST(column_prop.value AS nvarchar(max)) AS column_comment
      FROM sys.objects o
      JOIN sys.schemas s ON s.schema_id = o.schema_id
      JOIN sys.columns c ON c.object_id = o.object_id
      LEFT JOIN sys.extended_properties table_prop
        ON table_prop.major_id = o.object_id
       AND table_prop.minor_id = 0
       AND table_prop.name = 'MS_Description'
      LEFT JOIN sys.extended_properties column_prop
        ON column_prop.major_id = c.object_id
       AND column_prop.minor_id = c.column_id
       AND column_prop.name = 'MS_Description'
      WHERE o.type IN ('U', 'V')
        AND o.is_ms_shipped = 0
        AND s.name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest')
      ORDER BY s.name, o.name, c.column_id
    `).then((result) => result.recordset as Array<Record<string, unknown>>);
  }

  private queryPrimaryKeys(pool: sql.ConnectionPool, _profile: ConnectionProfile): Promise<Array<Record<string, unknown>>> {
    return pool.request().query(`
      SELECT
        s.name AS schema_name,
        t.name AS table_name,
        c.name AS column_name
      FROM sys.key_constraints kc
      JOIN sys.tables t ON t.object_id = kc.parent_object_id
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      JOIN sys.index_columns ic
        ON ic.object_id = t.object_id
       AND ic.index_id = kc.unique_index_id
      JOIN sys.columns c
        ON c.object_id = t.object_id
       AND c.column_id = ic.column_id
      WHERE kc.type = 'PK'
        AND s.name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest')
      ORDER BY s.name, t.name, ic.key_ordinal
    `).then((result) => result.recordset as Array<Record<string, unknown>>);
  }

  private queryForeignKeys(pool: sql.ConnectionPool, _profile: ConnectionProfile): Promise<Array<Record<string, unknown>>> {
    return pool.request().query(`
      SELECT
        parent_schema.name AS schema_name,
        parent_table.name AS table_name,
        parent_column.name AS column_name,
        fk.name AS constraint_name,
        referenced_schema.name AS foreign_schema,
        referenced_table.name AS foreign_table,
        referenced_column.name AS foreign_column
      FROM sys.foreign_keys fk
      JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
      JOIN sys.tables parent_table ON parent_table.object_id = fkc.parent_object_id
      JOIN sys.schemas parent_schema ON parent_schema.schema_id = parent_table.schema_id
      JOIN sys.columns parent_column
        ON parent_column.object_id = parent_table.object_id
       AND parent_column.column_id = fkc.parent_column_id
      JOIN sys.tables referenced_table ON referenced_table.object_id = fkc.referenced_object_id
      JOIN sys.schemas referenced_schema ON referenced_schema.schema_id = referenced_table.schema_id
      JOIN sys.columns referenced_column
        ON referenced_column.object_id = referenced_table.object_id
       AND referenced_column.column_id = fkc.referenced_column_id
      WHERE parent_table.is_ms_shipped = 0
        AND parent_schema.name NOT IN ('sys', 'INFORMATION_SCHEMA')
        AND parent_schema.name <> 'guest'
      ORDER BY parent_schema.name, parent_table.name, fk.name, fkc.constraint_column_id
    `).then((result) => result.recordset as Array<Record<string, unknown>>);
  }

  private queryIndexes(pool: sql.ConnectionPool, _profile: ConnectionProfile): Promise<Array<Record<string, unknown>>> {
    return pool.request().query(`
      SELECT
        s.name AS schema_name,
        t.name AS table_name,
        i.name AS index_name,
        i.is_unique,
        c.name AS column_name
      FROM sys.indexes i
      JOIN sys.tables t ON t.object_id = i.object_id
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      JOIN sys.index_columns ic
        ON ic.object_id = i.object_id
       AND ic.index_id = i.index_id
      JOIN sys.columns c
        ON c.object_id = t.object_id
       AND c.column_id = ic.column_id
      WHERE t.is_ms_shipped = 0
        AND i.type > 0
        AND i.is_hypothetical = 0
        AND i.is_primary_key = 0
        AND i.is_unique_constraint = 0
        AND s.name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest')
      ORDER BY s.name, t.name, i.name, ic.key_ordinal, ic.index_column_id
    `).then((result) => result.recordset as Array<Record<string, unknown>>);
  }

  private queryRoutines(pool: sql.ConnectionPool, _profile: ConnectionProfile): Promise<Array<Record<string, unknown>>> {
    return pool.request().query(`
      SELECT
        s.name AS schema_name,
        o.name AS routine_name,
        o.type AS routine_type,
        CAST(routine_prop.value AS nvarchar(max)) AS routine_comment,
        p.name AS parameter_name,
        TYPE_NAME(p.user_type_id) AS data_type,
        p.max_length,
        p.precision,
        p.scale,
        p.parameter_id,
        p.is_output
      FROM sys.objects o
      JOIN sys.schemas s ON s.schema_id = o.schema_id
      LEFT JOIN sys.parameters p ON p.object_id = o.object_id
      LEFT JOIN sys.extended_properties routine_prop
        ON routine_prop.major_id = o.object_id
       AND routine_prop.minor_id = 0
       AND routine_prop.name = 'MS_Description'
      WHERE o.type IN ('P', 'PC', 'FN', 'IF', 'TF', 'FS', 'FT')
        AND o.is_ms_shipped = 0
        AND s.name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest')
      ORDER BY s.name, o.name, p.parameter_id
    `).then((result) => result.recordset as Array<Record<string, unknown>>);
  }

  private ensureSchema(schemasMap: Map<string, MssqlSchemaEntry>, name: string): MssqlSchemaEntry {
    if (!schemasMap.has(name)) {
      schemasMap.set(name, {
        name,
        tables: new Map(),
        views: new Map(),
        procedures: [],
        functions: []
      });
    }
    return schemasMap.get(name)!;
  }

  private extractColumns(
    recordset: sql.IRecordSet<Record<string, unknown>> | undefined,
    rows: Record<string, unknown>[]
  ): QueryColumn[] {
    const metadata = recordset?.columns as Record<string, unknown> | undefined;
    if (metadata) {
      return Object.entries(metadata).map(([fallbackName, raw]) => {
        const meta = raw as { name?: string; type?: { name?: string; declaration?: string } };
        return {
          name: meta.name || fallbackName,
          type: meta.type?.declaration || meta.type?.name
        };
      });
    }

    const first = rows[0];
    return first ? Object.keys(first).map((name) => ({ name })) : [];
  }

  private formatType(row: Record<string, unknown>): string {
    const type = (getString(row, 'data_type') || 'unknown').toLowerCase();
    const maxLength = getNumber(row, 'max_length');
    const precision = getNumber(row, 'precision');
    const scale = getNumber(row, 'scale');

    if (['varchar', 'char', 'varbinary', 'binary'].includes(type) && maxLength !== undefined) {
      return maxLength === -1 ? `${type}(max)` : `${type}(${maxLength})`;
    }

    if (['nvarchar', 'nchar'].includes(type) && maxLength !== undefined) {
      return maxLength === -1 ? `${type}(max)` : `${type}(${Math.floor(maxLength / 2)})`;
    }

    if (['decimal', 'numeric'].includes(type) && precision !== undefined && scale !== undefined) {
      return `${type}(${precision},${scale})`;
    }

    if (['datetime2', 'datetimeoffset', 'time'].includes(type) && scale !== undefined) {
      return `${type}(${scale})`;
    }

    return type;
  }

  private buildRoutineSignature(routine: RoutineModel): string {
    const args = (routine.parameters ?? [])
      .map((parameter) => {
        const modeSuffix = parameter.mode === 'out' ? ' OUTPUT' : '';
        const typeSuffix = parameter.type ? ` ${parameter.type}` : '';
        return `${parameter.name}${typeSuffix}${modeSuffix}`.trim();
      })
      .join(', ');
    return `${routine.name}(${args})`;
  }
}

function toJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') {
    return value <= Number.MAX_SAFE_INTEGER && value >= Number.MIN_SAFE_INTEGER
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('base64');
  }
  if (Array.isArray(value)) {
    return value.map(toJsonSafe);
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toJsonSafe(nested);
    }
    return out;
  }
  return value;
}

function getString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  if (typeof value === 'string') return value.trim() || undefined;
  if (value === null || value === undefined) return undefined;
  return String(value);
}

function getNumber(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function getBool(row: Record<string, unknown>, key: string): boolean {
  const value = row[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true';
  return false;
}
