import { ContentScript } from 'cozy-clisk/dist/contentscript'
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

let billsJSON = []
// Here we need to override the fetch function to intercept the bills data sent by the website
// when we reach the bills page. Scraping is extremly tricky to achieve as there is no explicit selectors
// we could use to be resilient to potential changes.
// Stocker la référence à la fonction d'origine fetch
const fetchOriginal = window.fetch

// Remplacer la fonction fetch par une nouvelle fonction
window.fetch = async (...args) => {
  const response = await fetchOriginal(...args)
  if (typeof args[0] === 'string' && args[0].includes('/graphql')) {
    await response
      .clone()
      .json()
      .then(body => {
        if (body?.data?.consulterPersonne) {
          // filter out other graphql requests
          billsJSON.push(body)
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

let FORCE_FETCH_ALL = false

class BouyguesTelecomContentScript extends ContentScript {
  async navigateToLoginForm() {
    this.log('info', 'navigateToLoginForm starts')
    await this.runInWorker(
      'click',
      'a[href="https://www.bouyguestelecom.fr/mon-compte"]'
    )
    await this.waitForElementInWorker('#bytelid_a360_login')
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
    const srcFromIframe = await this.evaluateInWorker(
      function getSrcFromIFrame() {
        return document.querySelector('#bytelid_a360_login').getAttribute('src')
      }
    )
    await this.goto(srcFromIframe)
    await this.waitForElementInWorker('#username')
    let credentials = await this.getCredentials()
    if (credentials && credentials.email && credentials.password) {
      try {
        this.log('info', 'Got credentials, trying autologin')
        await this.tryAutoLogin(credentials)
      } catch (error) {
        this.log('warn', 'autoLogin error' + error.message)
        await this.showLoginFormAndWaitForAuthentication()
      }
    } else {
      this.log('info', 'No credentials found, waiting for user input')
      await this.showLoginFormAndWaitForAuthentication()
    }
    return true
  }

  async ensureNotAuthenticated() {
    this.log('info', '🤖 ensureNotAuthenticated starts')
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (authenticated) {
      const disconnectButtonSelector = '[class*=tri-power]'
      await this.goto(baseUrl)
      await this.waitForElementInWorker('p', { includesText: 'Me déconnecter' })
      await this.runInWorker('click', disconnectButtonSelector)
      await this.runInWorkerUntilTrue({ method: 'checkSessionStorage' })
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
    const passwordField = document.querySelector('#password')
    const loginField = document.querySelector('#username')
    if (passwordField && loginField) {
      const userCredentials = await this.findAndSendCredentials.bind(this)(
        loginField,
        passwordField
      )
      this.log('debug', "Sending user's credentials to Pilot")
      this.sendToPilot({
        userCredentials
      })
    }
    await this.checkIfAskingForCode()
    if (document.location.href.includes(successUrlPattern)) {
      // This url appears when the login has been successfull in the iframe
      // we then redirect the base url to let the next checkAuthenticated validate the login
      this.log(
        'debug',
        'found success url pattern, redirecting to base page: ' +
          document.location.href
      )
      document.location.href = baseUrl
      return false
    } else {
      this.log('debug', '👅 not success url pattern: ' + document.location.href)
    }

    try {
      const tokenExpire = JSON.parse(
        window.sessionStorage.getItem('SSO_payload')
      )?.exp

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

  async checkSessionStorage() {
    this.log('info', '📍️ checkSessionStorage starts')
    await waitFor(
      () => {
        const sessionStorageUserLogin =
          window.sessionStorage.getItem('a360-user-login')
        if (!sessionStorageUserLogin) {
          return true
        } else return false
      },
      {
        interval: 1000,
        timeout: 30 * 1000
      }
    )
    return true
  }

  async findAndSendCredentials(loginField, passwordField) {
    this.log('debug', 'findAndSendCredentials starts')
    let userLogin = loginField.value
    let userPassword = passwordField.value
    const userCredentials = {
      email: userLogin,
      password: userPassword
    }
    return userCredentials
  }

  async showLoginFormAndWaitForAuthentication() {
    this.log('info', 'showLoginFormAndWaitForAuthentication start')
    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({
      method: 'waitForAuthenticated'
    })
    await this.setWorkerState({ visible: false })
  }

  async getUserDataFromWebsite() {
    this.log('info', '🤖 getUserDataFromWebsite starts')
    await this.navigateToMonComptePage()
    const isActive = await this.navigateToInfosPage()
    await this.runInWorker('fetchIdentity', isActive)
    if (!this.store.userIdentity?.email) {
      throw new Error(
        'getUserDataFromWebsite: Could not find email in user identity'
      )
    }
    return {
      sourceAccountIdentifier: this.store.userIdentity.email[0].address
    }
  }

  async fetch(context) {
    this.log('info', '🤖 fetch starts')
    if (this.store.userCredentials) {
      await this.saveCredentials(this.store.userCredentials)
    }

    const { trigger } = context
    // force fetch all data (the long way) when last trigger execution is older than 30 days
    // or when the last job was an error
    const isLastJobError =
      trigger.current_state?.last_failure > trigger.current_state?.last_success
    const hasLastExecution = Boolean(trigger.current_state?.last_execution)
    const distanceInDays = getDateDistanceInDays(
      trigger.current_state?.last_execution
    )
    if (distanceInDays >= 30 || !hasLastExecution || isLastJobError) {
      this.log('info', `isLastJobError: ${isLastJobError}`)
      this.log('info', `distanceInDays: ${distanceInDays}`)
      this.log('info', `hasLastExecution: ${hasLastExecution}`)
      FORCE_FETCH_ALL = true
    }
    this.log('info', `FORCE_FETCH_ALL: ${FORCE_FETCH_ALL}`)

    const moreBillsButtonSelector =
      '#page > section > .container > .has-text-centered > a'
    await this.navigateToBillsPage()
    await this.waitForElementInWorker('div[class="box is-loaded"]')
    await this.runInWorkerUntilTrue({
      method: 'waitForInterception',
      args: [1]
    })

    let moreBills = true
    let lap = 0
    while (moreBills) {
      const lengthToCheck = await this.evaluateInWorker(
        function getBillsElementsLength() {
          return document.querySelectorAll(
            '.has-background-white > .container > .container > .box.is-loaded'
          ).length
        }
      )
      lap++
      moreBills = await this.isElementInWorker(moreBillsButtonSelector)
      if (moreBills) {
        await this.runInWorker('click', moreBillsButtonSelector)
        await Promise.all([
          this.runInWorkerUntilTrue({
            method: 'waitForInterception',
            args: [lap + 1]
          }),
          this.runInWorkerUntilTrue({
            method: 'checkBillsElementLength',
            args: [lengthToCheck]
          })
        ])
      }
      // only fetch the first page when not in fetch all mode
      if (!FORCE_FETCH_ALL) {
        moreBills = false
      }
    }
    const neededIndex = this.store.arrayLength - 1
    const pageBills = await this.runInWorker('computeBills', {
      lap,
      neededIndex
    })
    this.log('info', `pageBills : ${JSON.stringify(Object.keys(pageBills))}`)
    this.log(
      'info',
      `pageBills - phone_invoices length : ${pageBills.phone_invoices?.length}`
    )
    this.log(
      'info',
      `pageBills - isp_invoices length : ${pageBills.isp_invoices?.length}`
    )
    this.log(
      'info',
      `pageBills - other_invoices length: ${pageBills.other_invoices?.length}`
    )
    if (pageBills.phone_invoices.length) {
      this.log('debug', 'Saving phone_invoice bills')
      await this.saveBills(pageBills.phone_invoices, {
        context,
        fileIdAttributes: ['vendorRef'],
        contentType: 'application/pdf',
        qualificationLabel: 'phone_invoice'
      })
    }
    if (pageBills.isp_invoices.length) {
      this.log('debug', 'Saving isp_invoice bills')
      await this.saveBills(pageBills.isp_invoices, {
        context,
        fileIdAttributes: ['vendorRef'],
        contentType: 'application/pdf',
        qualificationLabel: 'isp_invoice'
      })
    }
    if (pageBills.other_invoices.length) {
      this.log('debug', 'Saving other_invoice bills')
      await this.saveBills(pageBills.other_invoices, {
        context,
        fileIdAttributes: ['vendorRef'],
        contentType: 'application/pdf',
        qualificationLabel: 'other_invoice'
      })
    }

    // saveIdentity in the end to have the first file visible to the user as soon as possible
    if (FORCE_FETCH_ALL && this.store.userIdentity) {
      await this.saveIdentity({ contact: this.store.userIdentity })
    }
    if (pageBills.skippedDocs) {
      this.log('warn', `${pageBills.skippedDocs} documents skipped`)
      throw new Error('UNKNOWN_ERROR.PARTIAL_SYNC')
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

  async tryAutoLogin(credentials) {
    this.log('info', 'TryAutologin starts')
    await this.autoLogin(credentials)
    await this.runInWorkerUntilTrue({ method: 'waitForAuthenticated' })
  }

  async autoLogin(credentials) {
    this.log('info', 'AutoLogin starts')
    await this.waitForElementInWorker('#username')
    await this.runInWorker('fillText', '#username', credentials.email)
    await this.runInWorker('fillText', '#password', credentials.password)
    await this.runInWorker('click', 'button')
  }

  async makeLoginFormVisible() {
    await waitFor(
      () => {
        const loginFormButton = document.querySelector('#login')
        if (loginFormButton) loginFormButton.click()

        if (document.querySelector('#bytelid_partial_acoMenu_login')) {
          return true
        } else {
          this.log(
            'info',
            'Cannot find loginfForm, closing pop over and returning false'
          )
          const closeButton = document.querySelector(
            'button[data-real-class="modal-close is-large"]'
          )
          if (closeButton) {
            closeButton.click()
          }
          return false
        }
      },
      {
        interval: 1000,
        timeout: {
          milliseconds: 15000,
          message: new TimeoutError(
            'makeLoginFormVisible timed out after 15000ms'
          )
        }
      }
    )
    return true
  }

  async navigateToInfosPage() {
    this.log('info', 'navigateToInfosPage starts')
    await this.waitForElementInWorker('div[href="/mon-compte/infosperso"] a')
    await this.clickAndWait(
      'div[href="/mon-compte/infosperso"] a',
      '.personalInfosAccountDetails'
    )
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
    await this.waitForElementInWorker('#bytelid_a360_login, #notifications')
  }

  async checkIfContractIsActive() {
    this.log('info', '📍️ checkIfContractIsActive starts')
    const fullSessionStorage = window.sessionStorage
    let wantedKey
    for (let i = 0; fullSessionStorage.length; i++) {
      const key = fullSessionStorage.key(i)
      if (key.match(/^bytel-api\/\[[0-9]*\]\/contrats\/[0-9]*$/)) {
        wantedKey = key
        break
      }
    }
    const keyContent = JSON.parse(window.sessionStorage.getItem(wantedKey))
    if (keyContent.data.data.statut !== 'ACTIF') {
      this.log('info', 'Actual contract is not active')
      return false
    } else {
      this.log('info', 'Actual contract is active')
      return true
    }
  }

  async fetchIdentity(isActive) {
    this.log('info', 'fetchIdentity starts')
    let mailAddress
    let phoneNumber
    const infosElements = document.querySelectorAll(
      '.personalInfosAccountDetails .tiles .segment:not(.flexCenter)'
    )
    const elementsArray = Array.from(infosElements)
    const infosArray = []
    for (const info of elementsArray) {
      const spans = info.querySelectorAll('span')
      if (
        spans[0].textContent.includes('Email') ||
        spans[0].textContent.includes('Numéro')
      ) {
        // Here we select index 1 because index 0 is the section's name
        const spanInfo = spans[1].textContent
        infosArray.push(spanInfo)
      }
      continue
    }
    mailAddress = infosArray[0]
    phoneNumber = infosArray[1].replace(/ /g, '')
    const firstName = document.querySelector('.firstName').textContent
    const familyName = document.querySelector('.name').textContent
    const userIdentity = {
      email: [{ address: mailAddress }],
      phone: [
        {
          type: phoneNumber.startsWith('06' || '07') ? 'mobile' : 'home',
          number: phoneNumber
        }
      ],
      name: {
        givenName: firstName,
        familyName
      }
    }
    // Apparently, user with resilied contract(s) can still access their bills but might not have postal addresse in their personnal infos.
    if (isActive) {
      const addressElement = document.querySelector(
        '.personalInfosBillingAddress .ui .is360 .text div[class="ui is360 text"] > span'
      )?.innerHTML
      if (addressElement) {
        const [street, postCodeAndCity, country] = addressElement.split('<br>')
        const [postCode, city] = postCodeAndCity.split(' ')
        userIdentity.address = [
          {
            street,
            postCode,
            city,
            country,
            formattedAddress: addressElement.replace(/<br>/g, ' ')
          }
        ]
      }
    } else {
      this.log(
        'info',
        'User seems to have no postal address linked to this contract'
      )
    }
    await this.sendToPilot({ userIdentity })
  }

  async checkInterception(number) {
    this.log('debug', 'checkInterception starts')
    this.log('debug', `number in checkInterception : ${number}`)
    if (billsJSON.length === number) {
      await this.sendToPilot({ arrayLength: billsJSON.length })
      return true
    }
    return false
  }

  async waitForInterception(number) {
    await waitFor(
      () => {
        return this.checkInterception(number)
      },
      {
        interval: 1000,
        timeout: 30 * 1000
      }
    )
    return true
  }

  async computeBills(infos) {
    this.log('debug', 'computeBills starts')
    const result = { phone_invoices: [], isp_invoices: [], other_invoices: [] }
    let skippedDocs = 0
    let comptesFacturation =
      billsJSON[infos.neededIndex].data.consulterPersonne.factures
        .comptesFacturation
    // Physical products invoices are separated from the mobile/isp invoices
    let otherTypeBills =
      billsJSON[infos.neededIndex].data.consulterPersonne.rechercherDocuments
        .documents
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
    // ensuring array is sorted from mostRecent to older
    foundBills.sort(sortDateFn)
    for (const foundBill of foundBills) {
      const fileHref = foundBill.facturePDF[0].href
      const amount = foundBill.mntTotFacture
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
          this.log('info', 'greater')
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
}

const connector = new BouyguesTelecomContentScript()
connector
  .init({
    additionalExposedMethodsNames: [
      'fetchIdentity',
      'waitForInterception',
      'computeBills',
      'makeLoginFormVisible',
      'checkBillsElementLength',
      'checkSessionStorage',
      'checkIfContractIsActive'
    ]
  })
  .catch(err => {
    log.warn(err)
  })

function getDateDistanceInDays(dateString) {
  const distanceMs = Date.now() - new Date(dateString).getTime()
  const days = 1000 * 60 * 60 * 24

  return Math.floor(distanceMs / days)
}
