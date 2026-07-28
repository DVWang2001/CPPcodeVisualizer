#include<iostream>
#include<cmath>
#include<vector>
using namespace std;
class Complex{
   double x,y;
   public:
   Complex(double a=0,double b=0):x(a),y(b){}
   Complex operator+(Complex p){return Complex(x+p.x,y+p.y);}
   Complex operator*(Complex p){return Complex(x*p.x-y*p.y,y*p.x+x*p.y);}
   Complex operator /(double b){return Complex(x/b,y/b);}
   friend istream &operator>>(istream &is,Complex &c);
   friend ostream& operator<<(ostream& os,const Complex& c);
};
istream &operator>>(istream &is,Complex &c){
                 char c1,c2;
                 is>>c.x>>c1>>c.y>>c2;
                 if(c1=='-')c.y*=-1;
        return is;
}
ostream& operator<<(ostream& os,const Complex& c){
        if(c.y==0)os<<c.x;
        else if(c.x==0)os<<c.y<<"i";
        else if(c.y<0) os<<c.x<<c.y<<"i";
        else os<<c.x<<"+"<<c.y<<"i";
   return os;
}
class CVec{
   vector<Complex>cv;
   public:
        Complex tol()const{
                Complex ans=cv[0];
                for(int i=1;i<cv.size();i++){
                        ans=ans+cv[i];
                }
                return ans;
        }
        Complex cross()const{
                Complex ans=cv[0];
                for(int i=1;i<cv.size();i++){
                        ans=ans*cv[i];
                }
                return ans;
        }
        Complex avg()const{
                return tol()/cv.size();
        }
                friend istream& operator>>(istream &is,CVec &a);
                friend ostream& operator<<(ostream &os,const CVec&a);
};
istream& operator>>(istream &is,CVec &a){
        Complex c;
        is>>c;
        a.cv.push_back(c);
   return is;
}
ostream& operator<<(ostream &os,const CVec&a){
                 os<<"sum:"<<a.tol()<<endl;
        os<<"Cross product:"<<a.cross()<<endl;
        os<<"avg:"<<a.avg()<<endl;
        return os;
}
int main(){
   int n;cin>>n;
   CVec c;
   while(n--){
      cin>>c;
   }
   cout<<c<<endl;  //@ @guide uml:c
   return 0;
}
