# RunQL Microsoft SQL Server Connector

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![VS Code](https://img.shields.io/badge/vscode-%5E1.96.0-007ACC)](https://code.visualstudio.com/)

Optional Microsoft SQL Server connector for the [RunQL](https://marketplace.visualstudio.com/items?itemName=RunQL-VSCode-Extension.runql) VS Code extension. Install alongside RunQL to query SQL Server and Azure SQL databases with RunQL's SQL workflows, results panel, schema introspection, and ERD tooling.

This extension is maintained separately so users who do not need Microsoft SQL Server are not required to install its database driver dependencies.

## Installation

1. Install [RunQL](https://marketplace.visualstudio.com/items?itemName=RunQL-VSCode-Extension.runql) (required, declared as an extension dependency).
2. Install **RunQL Microsoft SQL Server Connector** from the VS Code Marketplace.

RunQL will detect the connector on activation and register Microsoft SQL Server as an available connection provider.

## Usage

1. Open the RunQL explorer view.
2. Click **Add Connection** and choose **Microsoft SQL Server**.
3. Provide host, port, database, and optionally a schema such as `dbo`.
4. On the **Auth** tab, enter a SQL login username and password.
5. Enable encrypted transport when required by your SQL Server or Azure SQL configuration.
6. Save and test the connection.

## Requirements

- VS Code `^1.96.0`
- [RunQL](https://marketplace.visualstudio.com/items?itemName=RunQL-VSCode-Extension.runql) extension
- A SQL Server or Azure SQL endpoint that accepts SQL login authentication

## Authentication

The connector currently supports SQL login / password authentication. Integrated authentication and Azure AD authentication are not implemented yet.

## How it works

On activation, this extension acquires the RunQL extension API and calls:

- `registerProvider(mssqlProvider)` to add Microsoft SQL Server to the connection form.
- `registerAdapter('mssql', () => new MssqlAdapter())` to wire the dialect to its implementation.

The adapter uses the [`mssql`](https://www.npmjs.com/package/mssql) Node package with the default Tedious driver.

## DB Admin connection type

RunQL core supports an optional `data_access` / `db_admin` connection type for providers that explicitly opt in with `supports.dbAdminConnectionType`. This connector does not currently enable DB Admin mode because SQL Server introspection is scoped to the selected database.

## Building from source

```bash
git clone https://github.com/DVCodeLabs/RunQL-MSSQL.git
cd RunQL-MSSQL
npm install
npm run package
```

To produce a local VSIX for testing:

```bash
npm install -g @vscode/vsce
vsce package
```

## Contributing

Issues and pull requests welcome at [DVCodeLabs/RunQL-MSSQL](https://github.com/DVCodeLabs/RunQL-MSSQL). Please follow the code of conduct shared with the RunQL project.

## License

MIT, see [LICENSE](./LICENSE).
