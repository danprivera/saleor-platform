@description('Globally-unique Storage Account name (lowercase alphanumeric, max 24 chars).')
param name string

@description('Azure region for the storage account.')
param location string

@description('Blob container name used for Saleor media uploads.')
param mediaContainerName string = 'media'

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

output accountName string = storageAccount.name
output id string = storageAccount.id
