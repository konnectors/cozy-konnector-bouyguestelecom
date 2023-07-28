import { ContentScript } from 'cozy-clisk/dist/contentscript'
import { format } from 'date-fns'
import waitFor, { TimeoutError } from 'p-wait-for'
import Minilog from '@cozy/minilog'
const log = Minilog('ContentScript')
Minilog.enable('bouyguestelecomCCC')

const baseUrl = 'https://bouyguestelecom.fr'
const monCompteUrl = `${baseUrl}/mon-compte`
const successUrlPattern = 'PICASSO-FRONT'
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
        billsJSON.push(body)
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

class BouyguesTelecomContentScript extends ContentScript {
  async navigateToBasePage() {
    this.log('info', 'navigateToBasePage starts')
    await this.goto(baseUrl)
    await this.waitForElementInWorker('[data-menu-open=user]')
    await this.runInWorker('waitForLocalStorage')
  }

  /**
   * Wait for a key in localStorage to be present to be sure a page is fully loaded
   */
  async waitForLocalStorage() {
    await waitFor(
      () => {
        const result = Boolean(
          window.localStorage.getItem('bytel-tag-commander/oauth')
        )
        return result
      },
      {
        interval: 100,
        timeout: {
          milliseconds: 1000,
          message: new TimeoutError(
            'waitForLocalStorage timed out after 1 second'
          )
        }
      }
    )
  }

  async navigateToLoginForm() {
    this.log('info', 'navigateToLoginForm starts')
    await this.runInWorkerUntilTrue({ method: 'makeLoginFormVisible' })
  }

  async ensureAuthenticated({ account }) {
    this.log('info', 'EnsureAuthenticated starts')
    let srcFromIframe
    if (!account) {
      await this.ensureNotAuthenticated()
    }
    await this.navigateToBasePage()
    if (await this.runInWorker('checkAuthenticated')) {
      this.log('info', 'Auth detected')
      return true
    }
    this.log('info', 'No auth detected')
    await this.navigateToLoginForm()
    srcFromIframe = await this.evaluateInWorker(function getSrcFromIFrame() {
      return document
        .querySelector('#bytelid_partial_acoMenu_login')
        .getAttribute('src')
    })
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
    this.log('info', 'ensureNotAuthenticated starts')
    await this.navigateToBasePage()
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      return true
    }

    if ((await this.isElementInWorker('#user')) === false) {
      throw new Error(
        'Could not disconnect from Bouygues telecom, no menu is available in the current page : ' +
          document.location.href
      )
    }

    await this.clickAndWait('[data-menu-open=user]', '[data-id-logout]')
    await this.clickAndWait('[data-id-logout]', '#menu')

    // will reload the page after 5s if needed this can confirm the deconnexion in degraded cases
    await this.evaluateInWorker(function reloadAfter5s() {
      window.setTimeout(() => window.location.reload(), 5000)
    })
    await this.runInWorkerUntilTrue({
      method: 'waitForNotAuthenticated'
    })
  }

  async checkAuthenticated() {
    this.log('info', 'checkAuthenticated starts')
    const passwordField = document.querySelector('#password')
    const loginField = document.querySelector('#username')
    if (passwordField && loginField) {
      const userCredentials = await this.findAndSendCredentials.bind(this)(
        loginField,
        passwordField
      )
      this.log('info', "Sending user's credentials to Pilot")
      this.sendToPilot({
        userCredentials
      })
    }

    if (document.location.href.includes(successUrlPattern)) {
      // This url appears when the login has been successfull in the iframe
      // we then redirect the base url to let the next checkAuthenticated validate the login
      this.log(
        'info',
        'found success url pattern, redirecting to base page: ' +
          document.location.href
      )
      document.location.href = baseUrl
      return false
    }

    try {
      const tokenExpire = JSON.parse(
        localStorage.getItem('bytel-tag-commander/jwt-data')
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
    this.log('info', 'Waiting for confirmation code')
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
            'waitForUserCode timed out after 5 minutes, it may be because the user did not fill in the confirmation code in timely manners or because the awaited selector is missing'
          )
        }
      }
    )
    return true
  }

  async findAndSendCredentials(loginField, passwordField) {
    this.log('info', 'findAndSendCredentials starts')
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
    this.log('info', 'getUserDataFromWebsite starts')
    await this.navigateToMonComptePage()
    await this.navigateToInfosPage()
    await this.runInWorker('fetchIdentity')
    if (!this.store.userIdentity?.email) {
      throw new Error(
        'getUserDataFromWebsite: Could not find email in user identity'
      )
    }
    return {
      sourceAccountIdentifier: this.store.userIdentity.email
    }
  }

  async fetch(context) {
    this.log('info', 'fetch starts')
    await this.saveCredentials(this.store.userCredentials)
    await this.saveIdentity({ contact: this.store.userIdentity })
    const moreBillsButtonSelector =
      '#page > section > .container > .has-text-centered > a'
    await this.navigateToBillsPage()
    await this.waitForElementInWorker('div[class="box is-loaded"]')
    await this.runInWorkerUntilTrue({
      method: 'checkInterception',
      args: [1]
    })

    let moreBills = true
    let lap = 0
    while (moreBills) {
      lap++
      moreBills = await this.isElementInWorker(moreBillsButtonSelector)
      if (moreBills) {
        await this.runInWorker('click', moreBillsButtonSelector)
        await this.runInWorkerUntilTrue({
          method: 'checkInterception',
          args: [lap + 1]
        })
      }
    }
    const neededIndex = this.store.arrayLength - 1
    const pageBills = await this.runInWorker('computeBills', {
      lap,
      neededIndex
    })
    for (const oneBill of pageBills) {
      const billToDownload = await this.runInWorker('getDownloadHref', oneBill)
      if (
        billToDownload.lineNumber.startsWith('06') ||
        billToDownload.lineNumber.startsWith('07')
      ) {
        await this.saveBills([billToDownload], {
          context,
          fileIdAttributes: ['vendorRef'],
          contentType: 'application/pdf',
          qualificationLabel: 'phone_invoice',
          subPath: `${billToDownload.lineNumber}`
        })
      } else {
        await this.saveBills([billToDownload], {
          context,
          fileIdAttributes: ['vendorRef'],
          contentType: 'application/pdf',
          qualificationLabel: 'isp_invoice',
          subPath: `${billToDownload.lineNumber}`
        })
      }
    }
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
          closeButton.click()
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
    // multiple ajax request update the content. Wait for every content to be present
    await this.waitForElementInWorker('.title_address')
  }

  async navigateToBillsPage() {
    this.log('info', 'navigateToBillsPage starts')
    await this.clickAndWait('#menu', '.has-ending-arrow')
    await this.evaluateInWorker(() => {
      document.querySelectorAll('.has-ending-arrow')[1].click()
    })
    await this.waitForElementInWorker('#page > section > .container')
  }

  async navigateToMonComptePage() {
    await this.goto(monCompteUrl)
    await Promise.race([
      this.waitForElementInWorker('#casiframe'),
      this.waitForElementInWorker('#notifications')
    ])
  }

  async fetchIdentity() {
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
    const addressElement = document.querySelector(
      '.personalInfosBillingAddress .ui .is360 .text div[class="ui is360 text"] > span'
    ).innerHTML
    const [street, postCodeAndCity, country] = addressElement.split('<br>')
    const [postCode, city] = postCodeAndCity.split(' ')
    const userIdentity = {
      email: mailAddress,
      phone: [
        {
          type: phoneNumber.startsWith('06' || '07') ? 'mobile' : 'home',
          number: phoneNumber
        }
      ],
      name: {
        givenName: firstName,
        familyName
      },
      address: [
        {
          street,
          postCode,
          city,
          country,
          formattedAddress: addressElement.replace(/<br>/g, ' ')
        }
      ]
    }
    await this.sendToPilot({ userIdentity })
    this.log('info', `${JSON.stringify(userIdentity)}`)
  }

  async checkInterception(number) {
    this.log('info', 'checkInterception starts')
    this.log('info', `number in checkInterception : ${number}`)
    if (billsJSON.length >= number) {
      await this.sendToPilot({ arrayLength: billsJSON.length })
      return true
    }
    return false
  }

  async computeBills(infos) {
    this.log('info', 'computeBills starts')
    const computedBills = []
    let comptesFacturation =
      billsJSON[infos.neededIndex].data.consulterPersonne.factures
        .comptesFacturation

    let foundBills = []
    for (let i = 0; i < comptesFacturation.length; i++) {
      const billsForOneLine = comptesFacturation[i].factures
      billsForOneLine.forEach(bill => {
        foundBills.push(bill)
      })
    }

    for (const foundBill of foundBills) {
      const fileHref = foundBill.facturePDF[0].href
      const amount = foundBill.mntTotFacture
      const foundDate = foundBill.dateFacturation
      const vendor = 'Bouygues Telecom'
      const date = new Date(foundDate)
      const formattedDate = format(date, 'yyyy-MM-dd')
      const currency = '€'
      const lineNumber = foundBill.lignes[0].numeroLigne
      let computedBill = {
        lineNumber,
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
      computedBills.push(computedBill)
    }
    return computedBills
  }

  async getDownloadHref(bill) {
    this.log('info', 'getDownloadHref starts')
    const hrefAndToken = await this.getFileDownloadHref(bill.fileurl)
    let goodBill = {
      ...bill
    }
    goodBill.fileurl = `${apiUrl}${hrefAndToken.downloadHref}`
    goodBill.requestOptions = {
      headers: {
        Authorization: `BEARER ${hrefAndToken.token}`
      }
    }
    return goodBill
  }

  async getFileDownloadHref(url) {
    this.log('info', 'getFileDownloadHref starts')
    const token = window.sessionStorage.getItem('a360-access_token')
    const response = await window.fetch(url, {
      headers: {
        Authorization: `BEARER ${token}`
      }
    })
    const data = await response.json()
    const downloadHref = data._actions.telecharger.action
    return { downloadHref, token }
  }
}

const connector = new BouyguesTelecomContentScript()
connector
  .init({
    additionalExposedMethodsNames: [
      'fetchIdentity',
      'checkInterception',
      'computeBills',
      'getDownloadHref',
      'makeLoginFormVisible',
      'waitForLocalStorage'
    ]
  })
  .catch(err => {
    log.warn(err)
  })
