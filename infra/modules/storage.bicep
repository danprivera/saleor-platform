@description('Globally-unique Storage Account name (lowercase alphanumeric, max 24 chars).')
param name string

@description('Azure region for the storage account.')
param location string

@description('Blob container name used for Saleor media uploads.')
param mediaContainerName string = 'media'

@description('Private blob container for Saleor PRIVATE_FILE_STORAGE (webhook payload files, invoices).')
param privateContainerName string = 'private'

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: name
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: true
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
}

// Public read access at the container (blob) level so Saleor-served media URLs work,
// while the account itself still requires keys/RBAC for management operations.
resource mediaContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobService
  name: mediaContainerName
  properties: {
    publicAccess: 'Blob'
  }
}

// Saleor's PRIVATE_FILE_STORAGE. Unset, it defaults to the API container's
// local disk: saleor-api writes each webhook payload there and saleor-worker,
// a different container, cannot read it - every non-deferred async webhook
// (FULFILLMENT_CREATED, ...) failed with FileNotFoundError (dashboard#416).
// No public access: payloads carry customer data.
resource privateContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobService
  name: privateContainerName
  properties: {
    publicAccess: 'None'
  }
}

output accountName string = storageAccount.name
output id string = storageAccount.id
