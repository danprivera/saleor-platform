@description('Name of the PostgreSQL Flexible Server (globally unique).')
param name string

@description('Azure region.')
param location string

@description('Administrator username for the Postgres server.')
param adminUsername string = 'saleoradmin'

@description('Administrator password for the Postgres server.')
@secure()
param adminPassword string

@description('Name of the application database to create.')
param databaseName string = 'saleor'

@description('Compute SKU, e.g. Standard_B1ms (Burstable).')
param skuName string = 'Standard_B1ms'

@description('Compute tier, e.g. Burstable.')
param skuTier string = 'Burstable'

@description('Postgres major version.')
param postgresVersion string = '15'

@description('Storage size in GB.')
param storageSizeGB int = 32

@description('Backup retention in days.')
param backupRetentionDays int = 7

@description('Availability zone to pin the server to (e.g. "1", "2", "3"). Empty string lets Azure auto-select.')
param availabilityZone string = ''

resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-06-01-preview' = {
  name: name
  location: location
  sku: {
    name: skuName
    tier: skuTier
  }
  properties: {
    version: postgresVersion
    administratorLogin: adminUsername
    administratorLoginPassword: adminPassword
    storage: {
      storageSizeGB: storageSizeGB
    }
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
    availabilityZone: availabilityZone
  }
}

// Allows traffic from any Azure-internal IP (Container Apps environments use
// dynamic outbound IPs, so a per-IP rule isn't practical without a NAT
// gateway/VNet integration). This is the standard approach for Flexible
// Server + non-VNet-integrated Container Apps.
resource allowAzureServices 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-06-01-preview' = {
  parent: postgresServer
  name: 'AllowAllAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-06-01-preview' = {
  parent: postgresServer
  name: databaseName
}

output fqdn string = postgresServer.properties.fullyQualifiedDomainName
output serverName string = postgresServer.name
