@description('Environment label, e.g. prod or stage. Used only for tagging.')
param environmentName string = 'prod'

@description('Azure region for all resources.')
param location string = 'eastus2'

@description('Name of the Container Apps managed environment.')
param containerAppsEnvironmentName string = 'rover-ai-env'

@description('Name of the Log Analytics workspace backing the Container Apps environment.')
param logAnalyticsName string = 'log-rover-saleor-${environmentName}'

@description('Globally-unique Storage Account name for Saleor media (lowercase alphanumeric, max 24 chars).')
param storageAccountName string

@description('Name of the user-assigned managed identity shared by the Saleor container apps/jobs.')
param identityName string = 'id-rover-saleor-${environmentName}'

@description('Name of the existing Key Vault holding application secrets.')
param keyVaultName string = 'rover-technologies-vault'

@description('Resource group of the existing Key Vault (may differ from this deployment\'s resource group).')
param keyVaultResourceGroup string = 'rover-technologies-rg'

@description('Image tag for ghcr.io/saleor/saleor.')
param apiImageTag string = '3.23'

@description('Image tag for ghcr.io/saleor/saleor-dashboard.')
param dashboardImageTag string = '3.23'

@description('Value for ALLOWED_HOSTS, e.g. api.rovershop.io')
param allowedHosts string

@description('Value for ALLOWED_GRAPHQL_ORIGINS')
param allowedGraphqlOrigins string = '*'

@description('Value for PUBLIC_URL, e.g. https://api.rovershop.io')
param publicUrl string

@description('Value for DASHBOARD_URL, e.g. https://admin.rovershop.io')
param dashboardUrl string

@description('Value for the Dashboard API_URL env var, e.g. https://api.rovershop.io/graphql/')
param apiGraphqlUrl string

@description('Value for DEFAULT_FROM_EMAIL')
param defaultFromEmail string

@description('Max replicas for the worker app.')
param workerMaxReplicas int = 1

@description('Max replicas for the api app.')
param apiMaxReplicas int = 3

@description('Name of the Azure Postgres Flexible Server.')
param postgresServerName string = 'psql-rover-saleor-${environmentName}'

@description('Administrator password for the Postgres Flexible Server.')
@secure()
param postgresAdminPassword string

@description('Availability zone to pin the Postgres server to (e.g. "1", "2", "3"). Empty string lets Azure auto-select.')
param postgresAvailabilityZone string = ''

@description('Compute SKU for the Postgres server, e.g. Standard_B1ms or Standard_B2s.')
param postgresSkuName string = 'Standard_B1ms'

var keyVaultUri = 'https://${keyVaultName}${environment().suffixes.keyvaultDns}/'
var postgresAdminUsername = 'saleoradmin'
var postgresDatabaseName = 'saleor'
var postgresDatabaseUrl = 'postgresql://${postgresAdminUsername}:${uriComponent(postgresAdminPassword)}@${postgres.outputs.fqdn}:5432/${postgresDatabaseName}?sslmode=require'

module logAnalytics 'modules/logAnalytics.bicep' = {
  name: 'logAnalytics'
  params: {
    name: logAnalyticsName
    location: location
  }
}

module containerAppsEnvironment 'modules/containerAppsEnvironment.bicep' = {
  name: 'containerAppsEnvironment'
  params: {
    name: containerAppsEnvironmentName
    location: location
    logAnalyticsCustomerId: logAnalytics.outputs.customerId
    logAnalyticsSharedKey: logAnalytics.outputs.sharedKey
  }
}

module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: {
    name: storageAccountName
    location: location
  }
}

module identity 'modules/identity.bicep' = {
  name: 'identity'
  params: {
    name: identityName
    location: location
  }
}

module postgres 'modules/postgres.bicep' = {
  name: 'postgres'
  params: {
    name: postgresServerName
    location: location
    adminUsername: postgresAdminUsername
    adminPassword: postgresAdminPassword
    databaseName: postgresDatabaseName
    availabilityZone: postgresAvailabilityZone
    skuName: postgresSkuName
  }
}

// Writes the composed DATABASE_URL into the shared, cross-resource-group Key Vault.
module postgresSecret 'modules/keyVaultSecret.bicep' = {
  name: 'postgresSecret'
  scope: resourceGroup(keyVaultResourceGroup)
  params: {
    keyVaultName: keyVaultName
    secretName: 'saleor-database-url'
    secretValue: postgresDatabaseUrl
  }
}

// Grants the shared identity "Key Vault Secrets User" on the existing vault,
// which lives in a different resource group.
module keyVaultAccess 'modules/keyVaultAccess.bicep' = {
  name: 'keyVaultAccess'
  scope: resourceGroup(keyVaultResourceGroup)
  params: {
    keyVaultName: keyVaultName
    principalId: identity.outputs.principalId
  }
}

module containerApps 'modules/containerApps.bicep' = {
  name: 'containerApps'
  params: {
    environmentId: containerAppsEnvironment.outputs.id
    location: location
    identityId: identity.outputs.id
    keyVaultUri: keyVaultUri
    storageAccountName: storage.outputs.accountName
    apiImageTag: apiImageTag
    dashboardImageTag: dashboardImageTag
    allowedHosts: allowedHosts
    allowedGraphqlOrigins: allowedGraphqlOrigins
    publicUrl: publicUrl
    dashboardUrl: dashboardUrl
    apiGraphqlUrl: apiGraphqlUrl
    defaultFromEmail: defaultFromEmail
    workerMaxReplicas: workerMaxReplicas
    apiMaxReplicas: apiMaxReplicas
  }
  dependsOn: [
    keyVaultAccess
    postgresSecret
  ]
}

module jobs 'modules/jobs.bicep' = {
  name: 'jobs'
  params: {
    environmentId: containerAppsEnvironment.outputs.id
    location: location
    identityId: identity.outputs.id
    keyVaultUri: keyVaultUri
    apiImageTag: apiImageTag
    storageAccountName: storage.outputs.accountName
  }
  dependsOn: [
    keyVaultAccess
    postgresSecret
  ]
}

output apiFqdn string = containerApps.outputs.apiFqdn
output postgresFqdn string = postgres.outputs.fqdn
output dashboardFqdn string = containerApps.outputs.dashboardFqdn
output identityPrincipalId string = identity.outputs.principalId
output storageAccountName string = storage.outputs.accountName
