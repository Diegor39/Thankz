import * as sodium from 'libsodium-wrappers'
import { windowRef } from '../MockWindow'
import { Logger } from '../utils/Logger'
import { PeerManager } from '../managers/PeerManager'
import { PostMessagePairingRequest } from '../types/PostMessagePairingRequest'
import { ExtendedPostMessagePairingResponse } from '../types/PostMessagePairingResponse'
import { Extension } from '../types/Extension'
import { StorageKey } from '../types/storage/StorageKey'
import { TransportType } from '../types/transport/TransportType'
import { ExtensionMessage } from '../types/ExtensionMessage'
import { ExtensionMessageTarget } from '../types/ExtensionMessageTarget'
import { TransportStatus } from '../types/transport/TransportStatus'
import { ConnectionContext } from '../types/ConnectionContext'
import { Origin } from '../types/Origin'
import { Storage } from '../storage/Storage'
import { PostMessageClient } from './clients/PostMessageClient'
import { Transport } from './Transport'

const logger = new Logger('PostMessageTransport')

let listeningForExtensions: boolean = false
let extensionsPromise: Promise<Extension[]> | undefined
let extensions: Extension[] | undefined

const addExtension = (extension: Extension): void => {
  if (!extensions) {
    extensions = []
  }

  if (!extensions.some((ext) => ext.id === extension.id)) {
    extensions.push(extension)
    windowRef.postMessage('extensionsUpdated', windowRef.location.origin)
  }
}

/**
 * @internalapi
 *
 *
 */
export class PostMessageTransport<
  T extends PostMessagePairingRequest | ExtendedPostMessagePairingResponse,
  K extends
    | StorageKey.TRANSPORT_POSTMESSAGE_PEERS_DAPP
    | StorageKey.TRANSPORT_POSTMESSAGE_PEERS_WALLET
> extends Transport<T, K, PostMessageClient> {
  public readonly type: TransportType = TransportType.POST_MESSAGE

  constructor(name: string, keyPair: sodium.KeyPair, storage: Storage, storageKey: K) {
    super(name, new PostMessageClient(name, keyPair), new PeerManager<K>(storage, storageKey))
  }

  public static async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fn = (event: any): void => {
        const data = event.data as ExtensionMessage<string>
        if (data && data.payload === 'pong') {
          resolve(true)
          windowRef.removeEventListener('message', fn)
        }
      }

      windowRef.addEventListener('message', fn)

      const message: ExtensionMessage<string> = {
        target: ExtensionMessageTarget.EXTENSION,
        payload: 'ping'
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      windowRef.postMessage(message as any, windowRef.location.origin)
    })
  }

  public static async getAvailableExtensions(): Promise<Extension[]> {
    if (extensionsPromise) {
      return extensionsPromise
    }

    if (extensions) {
      return extensions
    }

    extensions = []
    extensionsPromise = new Promise<Extension[]>((resolve) => {
      PostMessageTransport.listenForExtensions()

      setTimeout(() => {
        resolve(extensions ?? [])
      }, 1000)
    }).finally(() => {
      extensionsPromise = undefined
    })

    return extensionsPromise
  }

  private static listenForExtensions(): void {
    if (listeningForExtensions) {
      return
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = (event: any): void => {
      const data = event.data as ExtensionMessage<
        string,
        { id: string; name: string; iconURL: string }
      >
      const sender = data.sender
      if (data && data.payload === 'pong' && sender) {
        logger.log('getAvailableExtensions', `extension "${sender.name}" is available`, sender)
        addExtension(sender)
      }
    }

    windowRef.addEventListener('message', fn)

    const message: ExtensionMessage<string> = {
      target: ExtensionMessageTarget.EXTENSION,
      payload: 'ping'
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    windowRef.postMessage(message as any, windowRef.location.origin)

    listeningForExtensions = true
  }

  public async connect(): Promise<void> {
    logger.log('connect')
    if (this._isConnected !== TransportStatus.NOT_CONNECTED) {
      return
    }

    this._isConnected = TransportStatus.CONNECTING

    const knownPeers = await this.getPeers()

    if (knownPeers.length > 0) {
      logger.log('connect', `connecting to ${knownPeers.length} peers`)
      const connectionPromises = knownPeers.map(async (peer) => this.listen(peer.publicKey))

      Promise.all(connectionPromises).catch((error) => logger.error('connect', error))
    }

    await this.startOpenChannelListener()

    await super.connect()
  }

  public async startOpenChannelListener(): Promise<void> {
    //
  }

  public async getPairingRequestInfo(): Promise<PostMessagePairingRequest> {
    return this.client.getPairingRequestInfo()
  }

  public async listen(publicKey: string): Promise<void> {
    logger.log('listen', publicKey)

    await this.client
      .listenForEncryptedMessage(publicKey, (message: string, context: ConnectionContext) => {
        const connectionContext: ConnectionContext = {
          origin: Origin.EXTENSION,
          id: context.id
        }

        this.notifyListeners(message, connectionContext).catch((error) => {
          throw error
        })
      })
      .catch((error) => {
        throw error
      })
  }
}
