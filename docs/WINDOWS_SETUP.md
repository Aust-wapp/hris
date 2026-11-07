# HRIS local development on Windows

This guide runs HRIS against its own local Supabase project in Docker. The Supabase project ID is **hris**; its database container and volume are separate from MTOP and other local projects. Never point this setup at the hosted HRIS project.

## Prerequisites

- Git for Windows.
- Node.js 22. The repository pins major version 22 in **.nvmrc**.
- Docker Desktop with its WSL 2 backend and at least 4 GiB of memory available.
- PowerShell.

Check the tools:

~~~powershell
node --version
npm --version
git --version
docker version
wsl --list --verbose
~~~

For this Windows setup, Node.js 22.23.3 is installed in the user profile. In each new PowerShell window, activate it before running project commands:

~~~powershell
$nodeHome = Join-Path $env:LOCALAPPDATA 'hris-runtime\node-v22.23.3-win-x64'
$env:PATH = "$nodeHome;$env:PATH"
node --version
npm --version
~~~

If setting up another computer, install Node.js 22 LTS or use nvm-windows and run **nvm use** in the repository.

## Install the project

If the repository is not already checked out:

~~~powershell
Set-Location "$HOME\Documents\Projects"
git clone https://github.com/Aust-wapp/hris.git
Set-Location .\hris
~~~

Install exactly the versions in the lockfile:

~~~powershell
npm ci
~~~

The Supabase CLI is installed as a project dependency; a global CLI install is not needed.

## Start the isolated database and configure the app

Confirm Docker is running, then start the HRIS stack:

~~~powershell
npm run db:start
~~~

The first start downloads the service images. On a new database, Supabase applies the migrations and **supabase/seed.sql**. The database is named **supabase_db_hris** and uses the **supabase_db_hris** Docker volume.

Create **.env.development.local** from the local CLI status without printing keys in the terminal:

~~~powershell
$nodeHome = Join-Path $env:LOCALAPPDATA 'hris-runtime\node-v22.23.3-win-x64'
$env:PATH = "$nodeHome;$env:PATH"
$envPath = Join-Path (Get-Location) '.env.development.local'
if (Test-Path -LiteralPath $envPath) {
  throw 'Refusing to overwrite an existing .env.development.local.'
}

$statusLines = & .\node_modules\.bin\supabase.cmd status --output env
if ($LASTEXITCODE -ne 0) {
  throw 'Could not read local Supabase status.'
}

$status = @{}
foreach ($line in $statusLines) {
  $match = [regex]::Match([string]$line, '^\s*([A-Z_]+)\s*=\s*(.*?)\s*$')
  if ($match.Success) {
    $status[$match.Groups[1].Value] = $match.Groups[2].Value.Trim('"')
  }
}

if ($status['API_URL'] -ne 'http://127.0.0.1:54421') {
  throw 'The API URL does not match the HRIS local configuration.'
}
foreach ($name in @('ANON_KEY', 'SERVICE_ROLE_KEY')) {
  if ([string]::IsNullOrWhiteSpace($status[$name])) {
    throw "Local Supabase status omitted $name."
  }
}

$envContents = @(
  '# Local development only. Do not put hosted credentials here.'
  "NEXT_PUBLIC_SUPABASE_URL=$($status['API_URL'])"
  "NEXT_PUBLIC_SUPABASE_ANON_KEY=$($status['ANON_KEY'])"
  "NEXT_PUBLIC_SERVICE_ROLE_KEY=$($status['SERVICE_ROLE_KEY'])"
  'DEV_LOGIN_PASSWORD=localdev'
)
[System.IO.File]::WriteAllText(
  (Join-Path (Get-Location) '.env.development.local'),
  ($envContents -join [Environment]::NewLine) + [Environment]::NewLine,
  [System.Text.UTF8Encoding]::new($false)
)
~~~

The file is gitignored. **NEXT_PUBLIC_SERVICE_ROLE_KEY** is read only by server-side code despite its name; never put it in client code. Do not create **.env.local**: this repository reserves that filename for a developer's hosted production credentials.

## Ports

| Service | Port | Notes |
| --- | ---: | --- |
| Next.js app | 3001 | Port 3000 was already occupied on this PC |
| Supabase API and Auth | 54421 | Local API URL is **http://127.0.0.1:54421** |
| PostgreSQL | 54422 | Local database only |
| Database shadow instance | 54420 | Used by migration tooling |
| Studio | 54423 | Disabled in **supabase/config.toml** |
| Local SMTP | 54424 | Disabled in **supabase/config.toml** |

Auth's local site URL and redirect allow-list are configured for ports 3001 on **localhost** and **127.0.0.1**. MTOP uses ports 54321–54324. Do not stop all Supabase projects to resolve a port conflict.

## Sign in locally

Google OAuth is not configured for localhost. Use the local-only development login page:

~~~text
http://localhost:3001/api/auth/dev-login
~~~

The seeded accounts all use password **localdev**:

| Email | Role |
| --- | --- |
| archive-user001@example.invalid | super_admin |
| archive-user001@example.invalid | hr_admin |
| archive-user001@example.invalid | department_head |
| archive-user001@example.invalid | employee |

The dev-login route only operates when the configured Supabase URL is a loopback address and **DEV_LOGIN_PASSWORD** is set. The normal login page's Google button requires OAuth credentials and is not the local sign-in path.

## Start and stop HRIS

In a PowerShell window, activate Node 22, then run:

~~~powershell
$nodeHome = Join-Path $env:LOCALAPPDATA 'hris-runtime\node-v22.23.3-win-x64'
$env:PATH = "$nodeHome;$env:PATH"
npm run db:start
npm run dev -- --port 3001
~~~

Open **http://localhost:3001**. Stop the app with Ctrl+C. To stop only the HRIS Supabase services while keeping their volume and data:

~~~powershell
npm run db:stop
~~~

Do not use **supabase stop --all**; it can stop unrelated local projects.

## Migrations, seeds, and checks

Create a migration using the project script:

~~~powershell
npm run db:new descriptive_name
~~~

Review the SQL, then rebuild the **local HRIS database** with all migrations and seed data:

~~~powershell
npm run db:reset
~~~

**db:reset** deletes and recreates the local HRIS database contents. It does not target MTOP or the hosted project. Never run **supabase link**, **supabase db push**, or **supabase db reset --linked**.

Available checks:

~~~powershell
npm run test:dtr
npm run test:cos
npm run test:db
npm run test:cos-db
npm test
npx tsc --noEmit
npm run lint
npm run build
~~~

Database integration tests require the local stack to be running. On Windows, set the telemetry opt-out only for the test session because parallel test workers invoke the Supabase CLI:

~~~powershell
$env:SUPABASE_TELEMETRY_DISABLED = '1'
npm test
Remove-Item Env:SUPABASE_TELEMETRY_DISABLED
~~~

This does not change the CLI's saved telemetry preference. **npm test** runs the project's unit and database test scripts.

## Troubleshooting

- **Docker is unavailable:** Open Docker Desktop, wait for the engine to start, then check **docker version**.
- **A port is occupied:** Inspect it before changing or stopping anything:

  ~~~powershell
  Get-NetTCPConnection -State Listen |
    Where-Object { $_.LocalPort -in 54420,54421,54422,54423,54424 } |
    Select-Object LocalAddress,LocalPort,OwningProcess
  ~~~

  Do not stop or remove MTOP containers or volumes. If HRIS ports need to change, update **supabase/config.toml**, **.env.development.local**, and this table together.
- **The database does not appear isolated:** Check that **project_id = "hris"** in **supabase/config.toml** and inspect only the HRIS container:

  ~~~powershell
  docker ps --all --filter name=supabase_db_hris
  docker inspect --format '{{.Name}} {{.State.Status}} {{range .Mounts}}{{.Name}}:{{.Destination}} {{end}}' supabase_db_hris
  ~~~
- **The dev-login route returns 404:** Check that **.env.development.local** points to **http://127.0.0.1:54421**, includes **DEV_LOGIN_PASSWORD**, and restart **npm run dev**.
- **A seeded login fails:** Confirm **npm run db:reset** completed successfully for HRIS and that **DEV_LOGIN_PASSWORD=localdev** matches the seeded password.
- **Queries return no rows:** HRIS tables live in the **hris** schema. Supabase client queries must use **.schema("hris")**.
