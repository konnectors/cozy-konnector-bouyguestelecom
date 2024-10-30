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

let billsJSON
// For obscure reasons, fetch override in requestInterceptor is not working as intended.
// I cannot find a way to fix this so until the problem is solved, we will do the override
// directly into the konnector's code as it works from here.
const fetchOriginal = window.fetch

window.fetch = async (...args) => {
  const response = await fetchOriginal(...args)
  if (typeof args[0] === 'string' && args[0].includes('/graphql')) {
    await response
      .clone()
      .json()
      .then(body => {
        if (body?.data?.consulterPersonne?.factures) {
          // filter out other graphql requests
          billsJSON = { ...body.data.consulterPersonne }
        }
        return response
      })
      .catch(err => {
        // eslint-disable-next-line no-console
        console.log(err)
        return response
      })
  }
  return response
}

const requestInterceptor = new RequestInterceptor([
  // {
  //   identifier: 'graphql',
  //   method: 'POST',
  //   url: 'https://api.bouyguestelecom.fr/graphql',
  //   exact: true,
  //   serialization: 'json'
  // },
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
        await this.waitForElementInWorker('p, a', {
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
          this.log('debug', 'No session login found, not connected')
          return true
        } else {
          this.log('debug', 'Session found, disconnecting ...')
          const disconnectButtonSelector =
            '[data-entrylink="deconnexion"] > div > a'
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
    // Keeping this around for cozy-pass solution exploration
    // const credentials = await this.getCredentials()
    // await this.runInWorker('autoFill', credentials)
    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({
      method: 'waitForAuthenticated'
    })
    await this.setWorkerState({ visible: false })
  }

  async getUserDataFromWebsite() {
    this.log('info', '🤖 getUserDataFromWebsite starts')
    await this.waitForRequestInterception('coordinates')
    let validSAI
    const coordinateEmail = await this.getUserMainEmail(
      this.store.coordinates.response?.emails
    )
    const savedCredentials = await this.getCredentials()
    // Prefer user Email instead of login if available
    if (!coordinateEmail) {
      validSAI = this.store.userCredentials.login || savedCredentials.login
    } else {
      validSAI = coordinateEmail
    }
    return { sourceAccountIdentifier: validSAI }
  }

  async getUserMainEmail(emailsArray) {
    this.log('info', '📍️ getUserMainEmail starts')
    for (const email of emailsArray) {
      if (email.emailPrincipal) {
        return email.email
      }
    }
    this.log('warn', 'No main email found')
    return null
  }

  async fetch(context) {
    this.log('info', '🤖 fetch starts')
    if (this.store.userCredentials) {
      await this.saveCredentials(this.store.userCredentials)
    }
    this.store.userId = await this.runInWorker('waitForUserId')

    const bills = await this.getBills()
    this.log(
      'info',
      `bills - phone_invoices length : ${bills.phone_invoices?.length}`
    )
    this.log(
      'info',
      `bills - isp_invoices length : ${bills.isp_invoices?.length}`
    )
    this.log(
      'info',
      `bills - other_invoices length: ${bills.other_invoices?.length}`
    )
    if (bills.phone_invoices.length) {
      this.log('debug', 'Saving phone_invoice bills')
      await this.saveBills(bills.phone_invoices, {
        context,
        fileIdAttributes: ['vendorRef'],
        contentType: 'application/pdf',
        qualificationLabel: 'phone_invoice'
      })
    }
    if (bills.isp_invoices.length) {
      this.log('debug', 'Saving isp_invoice bills')
      await this.saveBills(bills.isp_invoices, {
        context,
        fileIdAttributes: ['vendorRef'],
        contentType: 'application/pdf',
        qualificationLabel: 'isp_invoice'
      })
    }
    if (bills.other_invoices.length) {
      this.log('debug', 'Saving other_invoice bills')
      await this.saveBills(bills.other_invoices, {
        context,
        fileIdAttributes: ['vendorRef'],
        contentType: 'application/pdf',
        qualificationLabel: 'other_invoice'
      })
    }

    this.store.userIdentity = await this.runInWorker(
      'fetchIdentity',
      this.store.userId,
      this.store.coordinates
    )
    if (this.store.userIdentity) {
      await this.saveIdentity({ contact: this.store.userIdentity })
    }
    // await this.waitForElementInWorker('[pause]')
  }

  async getBills() {
    this.log('info', '📍️ getBills starts')
    this.store.linesData = await this.runInWorker(
      'fetchLinesData',
      this.store.userId
    )
    await this.runInWorker(
      'click',
      '[data-entrylink="acoFactures"] [role="button"]'
    )
    await this.waitForElementInWorker('a', { includesText: 'Télécharger' })
    const moreBillsButtonSelector =
      '#page > section > .container > .has-text-centered > a'
    await this.waitForElementInWorker(moreBillsButtonSelector)
    if (await this.isElementInWorker(moreBillsButtonSelector)) {
      await this.loadMoreBills(moreBillsButtonSelector)
    }
    const billsData = await this.runInWorkerUntilTrue({
      method: 'checkInterception'
    })
    const finalBills = await this.computeBills(billsData)
    return finalBills
  }

  async loadMoreBills(selector) {
    this.log('info', '📍️ loadMoreBills starts')
    const wantedElement = selector
    let hasMoreBills = true
    while (hasMoreBills) {
      const lengthToCheck = await this.evaluateInWorker(
        function getBillsElementsLength() {
          return document.querySelectorAll(
            '.has-background-white > .container > .container > .box.is-loaded'
          ).length
        }
      )
      hasMoreBills = await this.isElementInWorker(wantedElement)
      if (hasMoreBills) {
        await this.runInWorker('click', wantedElement)
        await Promise.all([
          this.runInWorkerUntilTrue({
            method: 'checkInterception'
          }),
          this.runInWorkerUntilTrue({
            method: 'checkBillsElementLength',
            args: [lengthToCheck]
          })
        ])
      }
    }
  }

  async checkBillsElementLength(lengthToCheck) {
    this.log('debug', '📍️ checkBillsElementLength starts')
    await waitFor(
      () => {
        this.log('info', `lengthToCheck : ${lengthToCheck}`)
        const billElementLength = document.querySelectorAll(
          '.has-background-white > .container > .container > .box.is-loaded'
        ).length
        this.log('info', `billElementLength : ${billElementLength}`)
        if (billElementLength > lengthToCheck) {
          this.log('info', 'more bills have been loaded')
          return true
        }
        return false
      },
      {
        interval: 1000,
        timeout: 30 * 1000
      }
    )

    return true
  }

  async computeBills(data) {
    this.log('info', '📍️ computeBills starts')

    const result = { phone_invoices: [], isp_invoices: [], other_invoices: [] }
    let skippedDocs = 0
    let comptesFacturation = data.factures.comptesFacturation
    // Physical products invoices are separated from the mobile/isp invoices
    let otherTypeBills = data.rechercherDocuments.documents
    let foundBills = []
    function sortFilenameFn(a, b) {
      a.filename > b.filename ? 1 : -1
    }
    function sortDateFn(a, b) {
      // All isp/phone bills
      if (a.dateFacturation) {
        a.dateFacturation > b.dateFacturation ? 1 : -1
      }
      // other type bills
      if (a.dateCreation) {
        a.dateCreation > b.dateCreation ? 1 : -1
      }
    }
    for (let i = 0; i < comptesFacturation.length; i++) {
      const billsForOneLine = comptesFacturation[i].factures
      billsForOneLine.forEach(bill => {
        foundBills.push(bill)
      })
    }
    const foundLineNumbers = document.querySelectorAll('.column > .is-nowrap')
    let i = 0
    // ensuring array is sorted from most recent to older
    foundBills.sort(sortDateFn)
    for (const foundBill of foundBills) {
      const fileHref = foundBill.facturePDF[0].href
      // Here we need to check if "mntTotalLigne" is present because this amount contains third-party services payments (like bus tickets payed by phone for example).
      // If this field is not present (and "lignes" can be empty or missing too), that means the user has no third-party services payment on current bill so we keep using "mntTotalLigne" as it is the subscription's price.
      const amount =
        foundBill.lignes[0]?.mntTotalLigne ?? foundBill.mntTotFacture
      const foundDate = foundBill.dateFacturation
      const vendor = 'Bouygues Telecom'
      const date = new Date(foundDate)
      const formattedDate = format(date, 'yyyy-MM-dd')
      const currency = '€'
      const lineNumber = foundBill.lignes[0]
        ? foundBill.lignes[0].numeroLigne
        : null
      const computedBill = {
        amount,
        currency,
        filename: `${formattedDate}_${vendor}_${amount}${currency}.pdf`,
        fileurl: `${apiUrl}${fileHref}`,
        date,
        vendor: 'Bouygues Telecom',
        vendorRef: foundBill.id,
        fileAttributes: {
          metadata: {
            contentAuthor: 'bouyguestelecom.fr',
            datetime: date,
            datetimeLabel: 'issueDate',
            isSubscription: true,
            issueDate: new Date(),
            carbonCopy: true
          }
        }
      }
      if (lineNumber) {
        computedBill.lineNumber = lineNumber
        computedBill.subPath = `${lineNumber}`
      } else {
        this.log(
          'warn',
          'It seems like no phone number is found, trying to scrape it instead'
        )
        // As foundBills has been sorted by date, we can select the element following loops
        const foundLineNumber = foundLineNumbers[i].textContent.replace(
          / /g,
          ''
        )
        if (!foundLineNumber) {
          this.log(
            'warn',
            'Cannot find any numbers, even scraping. Cannot qualify the document, skipping this doc.'
          )
          skippedDocs++
          continue
        }
        computedBill.lineNumber = foundLineNumber
        computedBill.subPath = `${foundLineNumber}`
      }
      if (
        computedBill.lineNumber.startsWith('06') ||
        computedBill.lineNumber.startsWith('07')
      ) {
        result.phone_invoices.push(computedBill)
      } else {
        result.isp_invoices.push(computedBill)
      }
      i++
    }
    this.log('info', 'computing otherBills')
    // physical products bills had a different structure, needs to be sorted separately
    if (otherTypeBills !== undefined && otherTypeBills.length) {
      this.log('info', 'will sort other by date')
      otherTypeBills.sort(sortDateFn)
      for (const otherBill of otherTypeBills) {
        const fileHref = otherBill.downloadLink[0].href
        const amount = otherBill.montantTTC
        const foundDate = otherBill.dateCreation
        const vendor = 'Bouygues Telecom'
        const date = new Date(foundDate)
        const formattedDate = format(date, 'yyyy-MM-dd')
        const currency = '€'
        const computedBill = {
          amount,
          currency,
          filename: `${formattedDate}_${vendor}_${amount}${currency}.pdf`,
          fileurl: `${apiUrl}${fileHref}`,
          date,
          vendor: 'Bouygues Telecom',
          vendorRef: otherBill.idDocument,
          fileAttributes: {
            metadata: {
              contentAuthor: 'bouyguestelecom.fr',
              datetime: date,
              datetimeLabel: 'issueDate',
              isSubscription: true,
              issueDate: new Date(),
              carbonCopy: true
            }
          }
        }
        result.other_invoices.push(computedBill)
      }
      result.other_invoices.sort(sortFilenameFn)
    }
    result.phone_invoices.sort(sortFilenameFn)
    result.isp_invoices.sort(sortFilenameFn)
    result.skippedDocs = skippedDocs
    return result
  }

  async checkInterception() {
    this.log('info', '📍️ checkInterception starts')
    await waitFor(
      () => {
        const isFull = Boolean(Object.keys(billsJSON).length)
        if (isFull) return true
        else return false
      },
      {
        interval: 1000,
        timeout: 30 * 1000
      }
    )
    return billsJSON
  }

  async fetchLinesData(userId) {
    this.log('info', '📍️ fetchLinesData starts')
    try {
      const identityStorageItem = JSON.parse(
        window.sessionStorage.getItem(`bytel-api/queriesByPersonId/[${userId}]`)
      )
      const linesData =
        identityStorageItem.value?.data?.consulterPersonne?.lignes?.items
      const lines = []
      for (const line of linesData) {
        lines.push({
          lineStatus: line.statut,
          lineNumber: line.numeroTel,
          contractInfo: {
            id: line.contrat.id,
            type: line.contrat.typeLigne,
            status: line.contrat.statut,
            offerName: line.contrat.abonnement.detailsAbonnement.libelle
          }
        })
      }
      return lines
    } catch (error) {
      this.log('warn', 'Could not found any lines data, cannot fetch bills')
      throw new Error('UNKNOWN_ERROR')
    }
  }

  async downloadFileInWorker(entry) {
    // overload ContentScript.downloadFileInWorker to be able to get the token and to run double
    // fetch request necessary to finally get the file
    this.log('debug', 'downloading file in worker')
    const token = window.sessionStorage.getItem('a360-access_token')
    const body = await ky
      .get(entry.fileurl, {
        headers: {
          Authorization: `BEARER ${token}`
        }
      })
      .json()
    const downloadHref = body._actions
      ? // isp/phone invoices
        body._actions.telecharger.action
      : // physical products invoices
        body._links.lienTelechargement.href
    const fileurl = `${apiUrl}${downloadHref}`

    const blob = await ky
      .get(fileurl, {
        headers: {
          Authorization: 'Bearer ' + token
        }
      })
      .blob()

    return await blobToBase64(blob)
  }

  async fetchIdentity(userId, userCoordinates) {
    this.log('info', 'fetchIdentity starts')
    const identityStorageItem = JSON.parse(
      window.sessionStorage.getItem(`bytel-api/queriesByPersonId/[${userId}]`)
    )
    const mailsData = userCoordinates.response?.emails
    const phonesData = userCoordinates.response?.telephones
    const personnalData = identityStorageItem.value?.data?.consulterPersonne
    const postalData = userCoordinates.response?.adressesPostales
    let userIdentity = {}
    if (personnalData) {
      this.log('info', '🦜️Fetching personnalData')
      const { nom: familyName, prenom: givenName } = personnalData
      userIdentity.name = { givenName, familyName }
    } else {
      this.log('warn', '🏮️ No personnalData at all')
    }
    if (mailsData) {
      this.log('info', '🦜️Fetching mailsData')
      if (mailsData.length) {
        this.log('info', '🦜️Found emails')
        userIdentity.email = []
        for (const email of mailsData) {
          if (email.emailPrincipal) {
            userIdentity.email.push({ address: email.email })
          }
        }
      } else {
        this.log('info', '🏮️ No contactData - emails found')
      }
      if (phonesData.length) {
        this.log('info', '🦜️Found phones')
        userIdentity.phone = []
        for (const phone of phonesData) {
          if (phone.numero) {
            userIdentity.phone.push({
              type: phone.typeTelephone === 'PORTABLE' ? 'mobile' : 'home',
              number: phone.numero
            })
          }
        }
      } else {
        this.log('info', '🏮️ No contactData - phones found')
      }
    } else {
      this.log('warn', '🏮️ No contactData at all')
    }
    if (postalData) {
      this.log('info', '🦜️Fetching postalData')
      if (postalData.length) {
        this.log('info', '🦜️Found addresses')
        userIdentity.address = []
        for (const item of postalData) {
          const formattedAddress = `${item.numero} ${item.rue} ${item.codePostal} ${item.ville} ${item.pays}`
          userIdentity.address.push({
            number: item.numero,
            street: item.rue,
            postCode: item.codePostal,
            city: item.ville,
            country: item.pays,
            formattedAddress
          })
        }
      } else {
        this.log('info', '🏮️ No postalData items found')
      }
    } else {
      this.log('warn', '🏮️ No postalData at all')
    }
    return userIdentity
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
    additionalExposedMethodsNames: [
      'getIframeSrc',
      'waitForUserId',
      'fetchIdentity',
      'fetchLinesData',
      'checkInterception',
      'checkBillsElementLength',
      'disconnectAndCheckSessionStorage'
    ]
  })
  .catch(err => {
    log.warn(err)
  })
