import {
  ContentScript,
  RequestInterceptor
} from 'cozy-clisk/dist/contentscript'
import { format } from 'date-fns'
import waitFor, { TimeoutError } from 'p-wait-for'
import Minilog from '@cozy/minilog'
import ky from 'ky'
import { blobToBase64 } from 'cozy-clisk/dist/contentscript/utils'

const log = Minilog('ContentScript')
Minilog.enable('bouyguestelecomCCC')

const baseUrl = 'https://bouyguestelecom.fr'
const monCompteUrl = `${baseUrl}/mon-compte`
const billsPageUrl = `${monCompteUrl}/mes-factures`
const successUrlPattern =
  'https://www.bouyguestelecom.fr/mon-compte/all/callback.html?code='
const apiUrl = 'https://api.bouyguestelecom.fr'

const requestInterceptor = new RequestInterceptor([
  {
    identifier: 'graphql',
    method: 'POST',
    url: '/graphql',
    serialization: 'json'
  },
  {
    identifier: 'coordinates',
    method: 'POST',
    url: '/coordonnees',
    serialization: 'json'
  }
])
requestInterceptor.init()

class BouyguesTelecomContentScript extends ContentScript {
  async onWorkerEvent({ event, payload }) {
    if (event === 'loginSubmit') {
      const { login, password } = payload || {}
      if (login && password) {
        this.store.userCredentials = { login, password }
      } else {
        this.log('warn', 'Did not manage to intercept credentials')
      }
    }
    if (event === 'requestResponse') {
      const { identifier, response } = payload
      if (identifier === 'graphql') {
        // All API calls are the same so we need to sort the interceptions on contained data
        if (response.data?.consulterPersonne?.factures) {
          this.store.userBills = response.data.consulterPersonne.factures
          this.log('debug', 'Bills intercepted')
        }
        if (response.data?.consulterPersonne?.prenom) {
          this.store.identityInfos = response.data.consulterPersonne
          this.log('debug', 'Identity intercepted')
        }
      } else {
        this.store[identifier] = { response }
      }
      // if (identifier === 'paiements' || identifier === 'datesNetSocial') {
      //   this.store.token = payload.requestHeaders.Authorization
      // }
    }
  }

  async onWorkerReady() {
    this.log('info', 'onWorkerReady starts')
    await this.waitForElementNoReload('form[data-roles="inputForm"]')
    this.addClickListener.bind(this)()
  }

  addClickListener() {
    this.log('info', 'adding listener')
    document
      .querySelector('form[data-roles="inputForm"] button[type="submit"]')
      // .querySelector('form[data-roles="inputForm"]')
      .addEventListener('click', () => {
        const login = document.querySelector(
          `input[name="username"][role="textbox"]`
        )?.value
        const password = document.querySelector(
          'input[type="password"][role="textbox"]'
        )?.value
        this.bridge.emit('workerEvent', {
          event: 'loginSubmit',
          payload: { login, password }
        })
      })
    // Deactivate keyboard "Enter" key to force user to click manually on the submitButton
    // For some reason worker emits nothing when user hit enter key
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault()
      }
    })
  }

  async ensureAuthenticated({ account }) {
    this.log('info', '🤖 EnsureAuthenticated starts')
    await this.navigateToMonComptePage()
    if (!account) {
      await this.ensureNotAuthenticated()
    }
    const authenticated = await this.runInWorker('checkAuthenticated')
    this.log('info', `authenticated : ${authenticated}`)
    if (authenticated) {
      return true
    }
    await this.waitForElementInWorker('#bytelid_a360_login')
    const srcIframe = await this.runInWorkerUntilTrue({
      method: 'getIframeSrc'
    })
    if (srcIframe) {
      await this.goto(srcIframe)
      await this.waitForElementInWorker('input[name="username"]')
    }
    await this.showLoginFormAndWaitForAuthentication()
    return true
  }

  async getIframeSrc() {
    this.log('info', '📍️ getIframeSrc starts')
    return document.querySelector('#bytelid_a360_login')?.getAttribute('src')
  }

  async ensureNotAuthenticated() {
    this.log('info', '🤖 ensureNotAuthenticated starts')
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (authenticated) {
      try {
        await this.waitForElementInWorker('p', {
          includesText: 'Me déconnecter'
        })
      } catch (err) {
        this.log('error', err.message)
        throw new Error('VENDOR_DOWN.NO_DISCONNECT_LINK')
      }
      await this.runInWorkerUntilTrue({
        method: 'disconnectAndCheckSessionStorage'
      })
      this.log(
        'info',
        'userLogin not found in sessionStorage : logout successful'
      )
      await this.navigateToMonComptePage()
    }

    return !authenticated
  }

  async checkAuthenticated() {
    this.log('debug', 'checkAuthenticated starts')
    await this.checkIfAskingForCode()
    if (document.location.href.includes(successUrlPattern)) {
      // This url appears when the login has been successfull in the iframe
      // we then redirect the base url to let the next checkAuthenticated validate the login
      this.log(
        'debug',
        'found success url pattern, redirecting to base page: ' +
          document.location.href
      )
      document.location.href = monCompteUrl
      return false
    } else {
      this.log('debug', '👅 not success url pattern: ' + document.location.href)
    }

    try {
      const tokenExpire = JSON.parse(
        window.sessionStorage.getItem('SSO_payload')
      )?.exp
      const userId = window.sessionStorage.getItem('a360-user-id')
      if (userId) {
        this.log('debug', 'userId found in sessionStorage, user logged')
        return true
      }
      if (!tokenExpire) {
        this.log('debug', 'checkauthenticated no tokenExpire')
        return false
      }

      const result = Date.now() < tokenExpire * 1000
      return result
    } catch (err) {
      this.log('debug', 'checkauthenticated error', err)
      return false
    }
  }

  async checkIfAskingForCode() {
    const radioTile = document.querySelector('.radio-tile')
    const codeInputs = document.querySelector('.otp')
    if (radioTile || codeInputs) {
      this.log('info', 'Website is asking for a confirmation code')
      await this.waitForUserCode()
      await this.runInWorker('click', 'button', { includesText: 'Continuer' })
    }
  }

  async waitForUserCode() {
    this.log('debug', 'Waiting for confirmation code')
    await waitFor(
      () => {
        const perfectNotification = document.querySelector('.is-level-2')
        if (perfectNotification) {
          if (perfectNotification.textContent === "C'est parfait") {
            this.log('info', 'User has filled his code, continue')
            document.querySelector('a').click()
            return true
          }
        }
        return false
      },
      {
        interval: 1000,
        timeout: {
          // Here it has been agreed we're using Infinity timeout as we're dependant on the user's input to continue the execution and we cannot cut off the execution while the user is waiting/writing its code.
          milliseconds: Infinity,
          message: new TimeoutError(
            'waitForUserCode timed out, it may be because the user did not fill in the confirmation code in timely manners or because the awaited selector is missing'
          )
        }
      }
    )
    return true
  }

  async disconnectAndCheckSessionStorage() {
    this.log('info', '📍️ disconnectAndCheckSessionStorage starts')
    await waitFor(
      () => {
        const sessionStorageUserLogin =
          window.sessionStorage.getItem('a360-user-login')
        if (!sessionStorageUserLogin) {
          return true
        } else {
          const disconnectButtonSelector = '[class*=tri-power]'
          const disconnectButton = document.querySelector(
            disconnectButtonSelector
          )
          if (disconnectButton) {
            disconnectButton.click()
          }
          return false
        }
      },
      {
        interval: 1000,
        timeout: 30 * 1000
      }
    )
    return true
  }

  async showLoginFormAndWaitForAuthentication() {
    this.log('info', 'showLoginFormAndWaitForAuthentication start')
    await this.setWorkerState({ visible: true })

    // Keeping this around for cozy-pass solution exploration
    // const credentials = await this.getCredentials()
    // this.runInWorker('autoFill', credentials)

    await this.runInWorkerUntilTrue({
      method: 'waitForAuthenticated'
    })
    await this.setWorkerState({ visible: false })
  }

  async getUserDataFromWebsite() {
    this.log('info', '🤖 getUserDataFromWebsite starts')
    await this.waitForRequestInterception('coordinates')
    this.log(
      'info',
      `this.store. : ${JSON.stringify(this.store.identityInfos)}`
    )
    await this.waitForElementInWorker('[pause]')
  }

  async fetch(context) {
    this.log('info', '🤖 fetch starts')
    if (this.store.userCredentials) {
      await this.saveCredentials(this.store.userCredentials)
    }
  }

  async navigateToInfosPage() {
    this.log('info', 'navigateToInfosPage starts')
    // await this.waitForElementInWorker('div[href="/mon-compte/infosperso"] a')
    // await this.clickAndWait(
    //   'div[href="/mon-compte/infosperso"] a',
    //   '.personalInfosAccountDetails'
    // )
    await this.waitForElementInWorker('a[data-roles="menuHeader"]', {
      includesText: 'Mes informations perso'
    })
    await this.runInWorker('click', 'a[data-roles="menuHeader"]', {
      includesText: 'Mes informations perso'
    })
    await this.waitForElementInWorker('.personalInfosAccountDetails')
    const isActive = await this.runInWorker('checkIfContractIsActive')
    if (isActive) {
      // multiple ajax request update the content. Wait for every content to be present
      await Promise.all([
        this.waitForElementInWorker(
          '.personalInfosAccountDetails .tiles .segment:not(.flexCenter)'
        ),
        this.waitForElementInWorker(
          '.personalInfosBillingAddress .ui .is360 .text div[class="ui is360 text"] > span'
        )
      ])
    } else {
      // if contract is not an active one, it might not contains any address to scrape
      this.waitForElementInWorker(
        '.personalInfosAccountDetails .tiles .segment:not(.flexCenter)'
      )
    }
    return isActive
  }

  async navigateToBillsPage() {
    this.log('info', 'navigateToBillsPage starts')
    await this.goto(billsPageUrl)
    await this.waitForElementInWorker('a', { includesText: 'Télécharger' })
  }

  async navigateToMonComptePage() {
    await this.goto(monCompteUrl)
    await Promise.race([
      this.waitForElementInWorker('#bytelid_a360_login'),
      this.runInWorkerUntilTrue({ method: 'waitForUserId' })
    ])
  }

  async waitForUserId() {
    this.log('info', '📍️ waitForUserId starts')
    let userId
    await waitFor(
      () => {
        const sessionStorageId = window.sessionStorage.getItem('a360-user-id')
        if (!sessionStorageId) return false
        userId = sessionStorageId
        return true
      },
      {
        interval: 1000,
        timeout: 30 * 1000
      }
    )
    return userId
  }
}

const connector = new BouyguesTelecomContentScript({ requestInterceptor })
connector
  .init({
    additionalExposedMethodsNames: ['getIframeSrc', 'waitForUserId']
  })
  .catch(err => {
    log.warn(err)
  })

function getDateDistanceInDays(dateString) {
  const distanceMs = Date.now() - new Date(dateString).getTime()
  const days = 1000 * 60 * 60 * 24

  return Math.floor(distanceMs / days)
}
