@description('Resource ID of the Container Apps managed environment.')
param environmentId string

@description('Azure region.')
param location string

@description('Resource ID of the user-assigned managed identity used to read Key Vault secrets.')
param identityId string

@description('Base URI of the Key Vault, e.g. https://rover-technologies-vault.vault.azure.net/')
param keyVaultUri string

@description('Storage account name used for Saleor media (Azure Blob Storage).')
param storageAccountName string

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

@description('Value for DEFAULT_CHANNEL_SLUG')
param defaultChannelSlug string = 'default-channel'

@description('Max replicas for the worker app (kept at 1 for the initial launch; increase once queue-based autoscaling is tuned).')
param workerMaxReplicas int = 1

@description('Max replicas for the api app.')
param apiMaxReplicas int = 3

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
    name: 'email-url'
    keyVaultUrl: '${keyVaultUri}secrets/rovershop-sendgrid-connection-string'
    identity: identityId
  }
  {
    name: 'storage-account-key'
    keyVaultUrl: '${keyVaultUri}secrets/saleor-storage-account-key'
    identity: identityId
  }
  {
    name: 'rsa-private-key'
    keyVaultUrl: '${keyVaultUri}secrets/saleor-rsa-private-key'
    identity: identityId
  }
]

var commonEnv = [
  { name: 'DEBUG', value: 'False' }
  { name: 'ALLOWED_CLIENT_HOSTS', value: allowedHosts }
  { name: 'SECRET_KEY', secretRef: 'secret-key' }
  { name: 'RSA_PRIVATE_KEY', secretRef: 'rsa-private-key' }
  { name: 'DATABASE_URL', secretRef: 'database-url' }
  { name: 'EMAIL_URL', secretRef: 'email-url' }
  { name: 'CACHE_URL', value: 'redis://valkey:6379/0' }
  { name: 'CELERY_BROKER_URL', value: 'redis://valkey:6379/1' }
  { name: 'DEFAULT_FROM_EMAIL', value: defaultFromEmail }
  { name: 'ALLOWED_HOSTS', value: allowedHosts }
  { name: 'ALLOWED_GRAPHQL_ORIGINS', value: allowedGraphqlOrigins }
  { name: 'PUBLIC_URL', value: publicUrl }
  { name: 'DASHBOARD_URL', value: dashboardUrl }
  { name: 'DEFAULT_CHANNEL_SLUG', value: defaultChannelSlug }
  { name: 'HTTP_IP_FILTER_ENABLED', value: 'True' }
  { name: 'HTTP_IP_FILTER_ALLOW_LOOPBACK_IPS', value: 'False' }
  { name: 'AZURE_CONTAINER', value: 'media' }
  { name: 'AZURE_ACCOUNT_NAME', value: storageAccountName }
  { name: 'AZURE_ACCOUNT_KEY', secretRef: 'storage-account-key' }
]

// Internal-only cache/broker. TCP ingress so it's reachable from other apps
// in the same environment at "valkey:6379" without being exposed externally.
resource valkey 'Microsoft.App/containerApps@2023-05-01' = {
  name: 'valkey'
  location: location
  properties: {
    environmentId: environmentId
    configuration: {
      ingress: {
        external: false
        targetPort: 6379
        transport: 'tcp'
      }
    }
    template: {
      containers: [
        {
          name: 'valkey'
          image: 'docker.io/valkey/valkey:8.1-alpine'
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

resource api 'Microsoft.App/containerApps@2023-05-01' = {
  name: 'saleor-api'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: identityRef
  }
  properties: {
    environmentId: environmentId
    configuration: {
      ingress: {
        external: true
        targetPort: 8000
        transport: 'auto'
        allowInsecure: false
      }
      secrets: commonSecrets
    }
    template: {
      containers: [
        {
          name: 'saleor-api'
          image: 'ghcr.io/saleor/saleor:${apiImageTag}'
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          env: commonEnv
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: apiMaxReplicas
        rules: [
          {
            name: 'http-scaling'
            http: {
              metadata: {
                concurrentRequests: '50'
              }
            }
          }
        ]
      }
    }
  }
  dependsOn: [
    valkey
  ]
}

resource worker 'Microsoft.App/containerApps@2023-05-01' = {
  name: 'saleor-worker'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: identityRef
  }
  properties: {
    environmentId: environmentId
    configuration: {
      secrets: commonSecrets
    }
    template: {
      containers: [
        {
          name: 'saleor-worker'
          image: 'ghcr.io/saleor/saleor:${apiImageTag}'
          command: [
            'celery'
          ]
          args: [
            '-A'
            'saleor'
            '--app=saleor.celeryconf:app'
            'worker'
            '--loglevel=info'
          ]
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          env: commonEnv
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: workerMaxReplicas
      }
    }
  }
  dependsOn: [
    valkey
  ]
}

// Fixed at exactly 1 replica: celery beat must never run more than one
// instance at a time or scheduled tasks will fire multiple times.
resource beat 'Microsoft.App/containerApps@2023-05-01' = {
  name: 'saleor-beat'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: identityRef
  }
  properties: {
    environmentId: environmentId
    configuration: {
      secrets: commonSecrets
    }
    template: {
      containers: [
        {
          name: 'saleor-beat'
          image: 'ghcr.io/saleor/saleor:${apiImageTag}'
          command: [
            'celery'
          ]
          args: [
            '-A'
            'saleor'
            '--app=saleor.celeryconf:app'
            'beat'
            '--loglevel=info'
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: commonEnv
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
  dependsOn: [
    valkey
  ]
}

resource dashboard 'Microsoft.App/containerApps@2023-05-01' = {
  name: 'saleor-dashboard'
  location: location
  properties: {
    environmentId: environmentId
    configuration: {
      ingress: {
        external: true
        targetPort: 80
        transport: 'auto'
        allowInsecure: false
      }
    }
    template: {
      containers: [
        {
          name: 'saleor-dashboard'
          image: 'ghcr.io/saleor/saleor-dashboard:${dashboardImageTag}'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'API_URL', value: apiGraphqlUrl }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 2
      }
    }
  }
}

output apiFqdn string = api.properties.configuration.ingress.fqdn
output dashboardFqdn string = dashboard.properties.configuration.ingress.fqdn
