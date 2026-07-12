@description('Resource ID of the Container Apps managed environment.')
param environmentId string

@description('Azure region.')
param location string

@description('Resource ID of the user-assigned managed identity used to read Key Vault secrets.')
param identityId string

@description('Base URI of the Key Vault, e.g. https://rover-technologies-vault.vault.azure.net/')
param keyVaultUri string

@description('Image tag for ghcr.io/saleor/saleor.')
param apiImageTag string = '3.23'

@description('Storage account name used for Saleor media (Azure Blob Storage).')
param storageAccountName string

var identityRef = {
  '${identityId}': {}
}

var commonSecrets = [
  {
    name: 'database-url'
    keyVaultUrl: '${keyVaultUri}secrets/saleor-database-url'
    identity: identityId
  }
  {
    name: 'secret-key'
    keyVaultUrl: '${keyVaultUri}secrets/saleor-secret-key'
    identity: identityId
  }
  {
    name: 'storage-account-key'
    keyVaultUrl: '${keyVaultUri}secrets/saleor-storage-account-key'
    identity: identityId
  }
]

var commonEnv = [
  { name: 'SECRET_KEY', secretRef: 'secret-key' }
  { name: 'DATABASE_URL', secretRef: 'database-url' }
  { name: 'AZURE_CONTAINER', value: 'media' }
  { name: 'AZURE_ACCOUNT_NAME', value: storageAccountName }
  { name: 'AZURE_ACCOUNT_KEY', secretRef: 'storage-account-key' }
  // Storage account rejects plain HTTP (AccountRequiresHttps) — Saleor defaults to HTTP without this
  { name: 'AZURE_SSL', value: 'True' }
]

// One-off migration job. Trigger manually with:
//   az containerapp job start --name saleor-migrate --resource-group <rg>
resource migrateJob 'Microsoft.App/jobs@2023-05-01' = {
  name: 'saleor-migrate'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: identityRef
  }
  properties: {
    environmentId: environmentId
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 1800
      replicaRetryLimit: 0
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      secrets: commonSecrets
    }
    template: {
      containers: [
        {
          name: 'saleor-migrate'
          image: 'ghcr.io/saleor/saleor:${apiImageTag}'
          command: [
            'python3'
          ]
          args: [
            'manage.py'
            'migrate'
          ]
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          env: commonEnv
        }
      ]
    }
  }
}

// One-off superuser creation job. Requires saleor-admin-email and
// saleor-admin-password secrets to exist in Key Vault before running.
// Trigger manually with:
//   az containerapp job start --name saleor-createsuperuser --resource-group <rg>
resource createSuperuserJob 'Microsoft.App/jobs@2023-05-01' = {
  name: 'saleor-createsuperuser'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: identityRef
  }
  properties: {
    environmentId: environmentId
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 0
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      secrets: union(commonSecrets, [
        {
          name: 'admin-email'
          keyVaultUrl: '${keyVaultUri}secrets/saleor-admin-email'
          identity: identityId
        }
        {
          name: 'admin-password'
          keyVaultUrl: '${keyVaultUri}secrets/saleor-admin-password'
          identity: identityId
        }
      ])
    }
    template: {
      containers: [
        {
          name: 'saleor-createsuperuser'
          image: 'ghcr.io/saleor/saleor:${apiImageTag}'
          command: [
            'python3'
          ]
          args: [
            'manage.py'
            'createsuperuser'
            '--noinput'
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: union(commonEnv, [
            { name: 'DJANGO_SUPERUSER_EMAIL', secretRef: 'admin-email' }
            { name: 'DJANGO_SUPERUSER_PASSWORD', secretRef: 'admin-password' }
          ])
        }
      ]
    }
  }
}
